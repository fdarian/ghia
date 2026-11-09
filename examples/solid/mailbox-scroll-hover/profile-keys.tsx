// Profiling proxy for ghia-bench's Type and Navigate phases on the test renderer, driving the bench's Mailbox (App.tsx, types.ts) under Bun.
// Type is "quarterly report" then 16 backspaces, 150 ms apart; navigate is 30 x ArrowDown, 120 ms apart; a key is down, then up 15 ms later,
// and the frames of the 1000/120 ms display link between keys, as the harness's `benchhelper phase` posts them to a live window.
//
// Run, from examples/ (the Vite config there compiles the Solid files):
//   cd examples && NODE_ENV=production GHIA_BENCH_MESSAGES=/path/to/ghia-bench/data/messages.json PHASE=type|navigate bun run profile-mailbox-keys
// Use a release addon. Instructions are the process's ri_instructions, which include every native and JavaScriptCore helper thread.
//
// Env:
//   GHIA_BENCH_MESSAGES  path of ghia-bench's data/messages.json (required)
//   PHASE=type|navigate  (type)
//   LOOPS=n              runs of the bench's key sequence in one process (1); the series per loop shows whether the cost settles. A type loop
//                        types and deletes the query, so it ends where it began; a navigate loop of 30 keys continues down the list
//   KEYS=n               overrides LOOPS: n keys in total (type cycles through its 32, navigate goes on down)
//   PACE=1               waits out each key's real period (150 / 120 ms) so JavaScriptCore's compiler threads run between keys as they do in
//                        a live window; PACE=0 runs the keys back to back (the JIT then races the main thread)
//   A11Y=0               takes the pretend screen reader away (as a bench run has none); on by default here
//   THREADS=1            prints each thread's CPU time over the keys (two snapshots, nothing polled while the keys run)
//   PER_KEY=1            prints every key's instructions
//   PRE_GC=1             Bun.gc(true) before the first key (separates startup garbage from the keys')
//   HEAP=1               prints bun:jsc heapStats and the JIT compile counters before and after the keys
//   MARK_RUNS=1          prints "=== run n done" on stderr after each run of the sequence, to split BUN_JSC_reportCompileTimes=1 output
//   BATCHES=1            counts the applyBatch calls, their JSON characters and mutation ops per key (parses each batch itself, so not for instruction counts)
//   HOLD_MS=0            waits before the keys (time to attach `sample`)
// Under a profiler: `bun --cpu-prof` and `--heap-prof` need the script as a Bun entry, so build it first (see testing.md): `ghia build` gives
// one JavaScript file that `bun --cpu-prof <file>` runs.
import { dlopen, ptr } from "bun:ffi"
import { existsSync, readFileSync } from "node:fs"
import { createTestRoot } from "@ghia/solid/testing"
import type { Message } from "./types"
import { App } from "./App"

const MESSAGES_PATH = process.env.GHIA_BENCH_MESSAGES
if (!MESSAGES_PATH) throw new Error("GHIA_BENCH_MESSAGES must be the path of ghia-bench's data/messages.json")
if (!existsSync(MESSAGES_PATH)) throw new Error(`GHIA_BENCH_MESSAGES is ${MESSAGES_PATH}, which does not exist`)
const PHASE = process.env.PHASE ?? "type"
if (PHASE !== "type" && PHASE !== "navigate") throw new Error(`PHASE must be type or navigate, got ${PHASE}`)
const PACE = process.env.PACE !== "0"
const THREADS = process.env.THREADS === "1"
const PER_KEY = process.env.PER_KEY === "1"
const HEAP = process.env.HEAP === "1"
const MARK_RUNS = process.env.MARK_RUNS === "1"
const BATCHES = process.env.BATCHES === "1"
const HOLD_MS = Number(process.env.HOLD_MS ?? "0")
const FRAME_MS = 1000 / 120
const KEY_UP_AT_MS = 15
const KEY_PERIOD_MS = PHASE === "type" ? 150 : 120

const SEQUENCE: string[] =
  PHASE === "type"
    ? [..."quarterly report"].map((character) => (character === " " ? "Space" : character)).concat(Array.from({ length: 16 }, () => "Backspace"))
    : Array.from({ length: 30 }, () => "ArrowDown")
const TOTAL_KEYS = process.env.KEYS ? Number(process.env.KEYS) : SEQUENCE.length * Number(process.env.LOOPS ?? "1")

const RUSAGE_INFO_V4 = 4
const RI_INSTRUCTIONS = 248
const PROC_PIDLISTTHREADIDS = 28
const PROC_PIDTHREADID64INFO = 15
const THREADINFO_SIZE = 112
const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
})
const rusageBuffer = new BigUint64Array(296 / 8)
const rusageView = new DataView(rusageBuffer.buffer)
const rusageAddress = ptr(rusageBuffer)
function readInstructions(): number {
  const status = libSystem.symbols.proc_pid_rusage(process.pid, RUSAGE_INFO_V4, rusageAddress)
  if (status !== 0) throw new Error(`proc_pid_rusage failed: ${status}`)
  return Number(rusageView.getBigUint64(RI_INSTRUCTIONS, true))
}

const idBuffer = new BigUint64Array(1024)
const infoBuffer = new ArrayBuffer(THREADINFO_SIZE)
const infoView = new DataView(infoBuffer)
const infoAddress = ptr(infoBuffer)
type ThreadTimes = { name: string; cpuNs: number }
function threadSnapshot(): Map<string, ThreadTimes> {
  const bytes = libSystem.symbols.proc_pidinfo(process.pid, PROC_PIDLISTTHREADIDS, 0n, ptr(idBuffer), idBuffer.byteLength)
  if (bytes <= 0) throw new Error("proc_pidinfo(PROC_PIDLISTTHREADIDS) failed")
  const threads = new Map<string, ThreadTimes>()
  for (let index = 0; index < bytes / 8; index++) {
    const id = idBuffer[index]
    if (id === undefined) throw new Error("thread id list shorter than its byte count")
    const written = libSystem.symbols.proc_pidinfo(process.pid, PROC_PIDTHREADID64INFO, id, infoAddress, THREADINFO_SIZE)
    if (written !== THREADINFO_SIZE) continue
    const raw = new Uint8Array(infoBuffer, 48, 64)
    const end = raw.indexOf(0)
    threads.set(String(id), {
      name: new TextDecoder().decode(raw.subarray(0, end < 0 ? 64 : end)),
      cpuNs: Number(infoView.getBigUint64(0, true)) + Number(infoView.getBigUint64(8, true)),
    })
  }
  return threads
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const M = (value: number, digits = 3) => (value / 1e6).toFixed(digits)

const messages = JSON.parse(readFileSync(MESSAGES_PATH, "utf8")) as Message[]
const root = createTestRoot({ width: 1280, height: 800, appearance: "light" })
const renderer = root.renderer
const native = (renderer as unknown as { native: { flushIfDirty(): void; simulateKeyDown(key: string): void; simulateKeyUp(key: string): void } }).native

const batchStats = { calls: 0, chars: 0, ops: 0 }
if (BATCHES) {
  const target = renderer as unknown as { applyBatch: (json: string) => number[] }
  const apply = target.applyBatch.bind(renderer)
  target.applyBatch = (json) => {
    batchStats.calls++
    batchStats.chars += json.length
    batchStats.ops += (JSON.parse(json) as unknown[]).length
    return apply(json)
  }
}

if (process.env.A11Y !== "1") renderer.setA11yActive(false)
const mountStart = performance.now()
root.render(() => <App messages={messages} />)
const mountMs = performance.now() - mountStart
renderer.clockPause()
renderer.setInlineDraws(false)

function frameStep(ms: number) {
  renderer.clockAdvance(ms)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}
for (let i = 0; i < 5; i++) frameStep(FRAME_MS)
renderer.clockAdvance(3000)
renderer.dispatchNativeEvents()
for (let i = 0; i < 5; i++) frameStep(FRAME_MS)
{
  let quiet = 0
  for (let i = 0; i < 600 && quiet < 120; i++) {
    const before = renderer.getPaintedFrameCount()
    frameStep(FRAME_MS)
    quiet = renderer.getPaintedFrameCount() === before ? quiet + 1 : 0
  }
  if (quiet < 120) throw new Error("the window still paints after 600 ticks of settling")
}
// The bench's window is key, with the search field focused (autoFocus), so its caret blinks.
renderer.setWindowActive(true)
const input = renderer.findByType("input")[0]
if (!input) throw new Error("no <input> in the app")
renderer.focusElement(input.id)
for (let i = 0; i < 20; i++) frameStep(FRAME_MS)
if (renderer.getFocusedElementId() !== input.id) throw new Error("the search input is not focused")

function pressKey(key: string, tail: () => void) {
  native.flushIfDirty()
  renderer.dispatchNativeEvents()
  native.simulateKeyDown(key)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
  renderer.clockAdvance(KEY_UP_AT_MS)
  renderer.dispatchNativeEvents()
  native.simulateKeyUp(key)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
  tail()
}

function restOfPeriod() {
  let elapsed = KEY_UP_AT_MS
  while (elapsed < KEY_PERIOD_MS - 1e-6) {
    const step = Math.min(FRAME_MS, KEY_PERIOD_MS - elapsed)
    frameStep(step)
    elapsed += step
  }
}

async function jscStats(label: string) {
  const jsc = await import("bun:jsc")
  const heap = jsc.heapStats()
  console.error(`${label}: heapSize ${heap.heapSize} heapCapacity ${heap.heapCapacity} extraMemory ${heap.extraMemorySize} objects ${heap.objectCount} protected ${heap.protectedObjectCount} totalCompileTime ${jsc.totalCompileTime?.()}`)
}

console.error(`mounted ${messages.length} messages in ${mountMs.toFixed(0)} ms, phase ${PHASE}, ${TOTAL_KEYS} keys, pace ${PACE ? "real time" : "off"}, pid ${process.pid}`)
if (HOLD_MS > 0) await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
if (process.env.PRE_GC === "1") Bun.gc(true)
if (HEAP) await jscStats("before keys")

const perKey: number[] = []
batchStats.calls = batchStats.chars = batchStats.ops = 0
/**
 * CPU ms by thread name since the first poll. JavaScriptCore's compiler threads exit when idle and a new one starts later, so a
 * before/after pair of snapshots loses the time of every thread that exited in between; the keys are polled (every POLL_MS in the pace
 * wait, a poll is one proc_pidinfo call per thread) and each thread's time is added as it grows.
 */
const POLL_MS = 20
const seenNs = new Map<string, number>()
const cpuMsByName = new Map<string, number>()
let mainThreadId: string | undefined
function pollThreads() {
  const threads = threadSnapshot()
  mainThreadId ??= [...threads.keys()].reduce((lowest, id) => (BigInt(id) < BigInt(lowest) ? id : lowest))
  for (const [id, thread] of threads) {
    const name = id === mainThreadId ? "main thread" : thread.name || "(unnamed)"
    cpuMsByName.set(name, (cpuMsByName.get(name) ?? 0) + (thread.cpuNs - (seenNs.get(id) ?? 0)) / 1e6)
    seenNs.set(id, thread.cpuNs)
  }
}
const groupOf = (name: string) => (/JIT/.test(name) ? "jit" : /Heap|Collector|scavenger/.test(name) ? "gc" : name === "main thread" ? "main" : "other")
function groupTotals() {
  const totals = { main: 0, jit: 0, gc: 0, other: 0 }
  for (const [name, ms] of cpuMsByName) totals[groupOf(name)] += ms
  return totals
}
const perRun: ReturnType<typeof groupTotals>[] = []
let runStart: ReturnType<typeof groupTotals> | undefined
if (THREADS) {
  pollThreads()
  cpuMsByName.clear()
  runStart = groupTotals()
}
const cpuBefore = process.cpuUsage()
const startInstructions = readInstructions()
const startWall = performance.now()
let paceDeadline = startWall
for (let index = 0; index < TOTAL_KEYS; index++) {
  const key = SEQUENCE[index % SEQUENCE.length]
  if (key === undefined) throw new Error("empty key sequence")
  const before = readInstructions()
  pressKey(key, restOfPeriod)
  perKey.push(readInstructions() - before)
  if (MARK_RUNS && (index + 1) % SEQUENCE.length === 0) console.error(`=== run ${(index + 1) / SEQUENCE.length} done`)
  if (THREADS) pollThreads()
  if (runStart && (index + 1) % SEQUENCE.length === 0) {
    const now = groupTotals()
    perRun.push({ main: now.main - runStart.main, jit: now.jit - runStart.jit, gc: now.gc - runStart.gc, other: now.other - runStart.other })
    runStart = now
  }
  if (PACE) {
    paceDeadline += KEY_PERIOD_MS
    const wait = paceDeadline - performance.now()
    for (let left = wait; left > 0; left = paceDeadline - performance.now()) {
      await new Promise((resolve) => setTimeout(resolve, THREADS ? Math.min(left, POLL_MS) : left))
      if (THREADS) pollThreads()
    }
  }
}
const totalInstructions = readInstructions() - startInstructions
const wallMs = performance.now() - startWall
const cpu = process.cpuUsage(cpuBefore)
if (THREADS) pollThreads()

const conversations = renderer.findByType("text").find((element) => element.text?.endsWith(" conversations"))?.text
console.error(`after the keys: "${conversations}"`)
console.log(`${PHASE}: ${TOTAL_KEYS} keys, ${M(totalInstructions, 1)}M instructions (${M(totalInstructions / TOTAL_KEYS)}M per key, median ${M(median(perKey))}M), wall ${wallMs.toFixed(0)} ms, process cpu user ${(cpu.user / 1000).toFixed(0)} ms system ${(cpu.system / 1000).toFixed(0)} ms`)
{
  const loopLength = SEQUENCE.length
  const loops: string[] = []
  for (let start = 0; start < perKey.length; start += loopLength) {
    const slice = perKey.slice(start, start + loopLength)
    loops.push(`${M(sum(slice) / slice.length, 2)}`)
  }
  console.log(`  mean M instr per key, by run of ${loopLength} keys: ${loops.join(" ")}`)
  if (PHASE === "type") {
    const half = (from: number, to: number) => {
      const values = perKey.filter((_, index) => index % loopLength >= from && index % loopLength < to)
      return M(sum(values) / Math.max(values.length, 1), 2)
    }
    console.log(`  type keys ${half(0, 16)}M, backspaces ${half(16, 32)}M`)
  }
}
if (PER_KEY) console.log(`  per key (M): ${perKey.map((value) => M(value, 2)).join(" ")}`)
if (BATCHES) {
  console.log(`  applyBatch per key: ${(batchStats.calls / TOTAL_KEYS).toFixed(2)} calls, ${(batchStats.chars / TOTAL_KEYS / 1024).toFixed(1)} KB of JSON, ${(batchStats.ops / TOTAL_KEYS).toFixed(0)} ops (the wrapper parses each batch: not for instruction counts)`)
}
if (THREADS) {
  const total = sum([...cpuMsByName.values()])
  console.log(`  threads: cpu ms over the keys (sum ${total.toFixed(0)} ms; est. M instr per key = share x ${M(totalInstructions / TOTAL_KEYS)}M)`)
  for (const [name, ms] of [...cpuMsByName].sort((a, b) => b[1] - a[1]).filter(([, value]) => value >= 0.5)) {
    console.log(`    ${name.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms  ${((ms / total) * (totalInstructions / TOTAL_KEYS) / 1e6).toFixed(2).padStart(6)}M per key`)
  }
}
if (perRun.length > 0) {
  console.log(`  CPU ms per key, by run: main ${perRun.map((run) => (run.main / SEQUENCE.length).toFixed(2)).join(" ")}`)
  console.log(`                          JIT  ${perRun.map((run) => (run.jit / SEQUENCE.length).toFixed(2)).join(" ")}`)
  console.log(`                          GC   ${perRun.map((run) => (run.gc / SEQUENCE.length).toFixed(2)).join(" ")}`)
}
if (HEAP) await jscStats("after keys")
root.unmount()
process.exit(0)
