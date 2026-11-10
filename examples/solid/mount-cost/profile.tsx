// What the instructions of mounting a Solid subtree go to, per phase, on the test renderer. Two fixtures:
//   detail    the bench's Detail pane (Detail.tsx, ~25 elements), driven by the selected-message signal;
//   settings  a mostly static settings dialog (Settings.tsx, ~200 elements) mounted and unmounted through a <Show> toggle.
// One step is: write the signal (Solid + host objects + the mount ops, synchronously), a microtask (finishRemovals, the end of the wire
// batch and `applyBatch`, which the queue schedules itself), then one `drawFrame()`. Stamps are the process's ri_instructions
// (every thread, as in profile-keys.tsx) read between the phases, so JIT and GC helper threads show up in the mean.
//
// Phases of a step (the stamps are in `step`):
//   js       signal write -> first createElement op of the mount: Solid's graph and component code, host objects, the old subtree's disposal
//            and removal (for a step with no mount, the whole write)
//   ops      first createElement op -> the write returns: `mount()` in host.ts, per element createElement/setStyle/setCustomProp/setEventListener/
//            appendChild through the mutation queue into the WireWriter
//   prep     the write returns -> `applyBatch` is called: the microtask, `finishRemovals` (markUnmounted and destroyElement ops of what left),
//            `writer.finish()`
//   apply    `applyBatch` (napi call, decode, resolve_styles, apply)
//   post     `applyBatch` returns -> the microtask ends (cancelAnimationsOfElements, onDestroyed, release)
//   frame    `drawFrame()` (build, layout, paint)
//
// Run, from examples/ (its Vite config compiles the Solid files), with a release addon and NODE_ENV=production:
//   cd examples && NODE_ENV=production GHIA_BENCH_MESSAGES=/path/to/ghia-bench/data/messages.json FIXTURE=detail MODE=swap bun run profile-mount-cost
//
// Env:
//   GHIA_BENCH_MESSAGES  path of ghia-bench's data/messages.json (required for FIXTURE=detail)
//   FIXTURE=detail|settings   (detail)
//   MODE=swap|toggle     swap: the signal goes to the next message (detail only: Detail's content is replaced, the bench's navigate);
//                        toggle: mount step then unmount step, alternating (detail: message <-> undefined, whose fallback is 3 elements;
//                        settings: <Show> true <-> false). The two kinds of step are reported separately. Default swap for detail, toggle for settings
//   K=300 WARMUP=100     measured and unmeasured mounts (a toggle does K mount steps and K unmount steps)
//   INSTRUMENT=0         no stamps inside the step and no wrapped queue/renderer: one total per step, to see what the stamps cost
//   SAME=1               detail toggle: the mount step always mounts the first message (its text is shaped once, so the frame has no new text to shape)
//   COUNT=1              no timing: counts the ops of each kind of step by opcode, their wire bytes and the elements created (decodes each batch)
//   MARK=1               prints "=== measured start" and "=== measured end" on stderr around the measured steps, to cut a BUN_JSC_logGC=1 log (alloc-per-step.sh)
//   YIELD=1              turns the event loop after every step (setImmediate), so GC timers run as in an app; the collections that follow are in the mean
//   PER_STEP=1           prints every step's total
//   PRE_GC=1             Bun.gc(true) before the measured steps
//   HOLD_MS=0            waits before the measured steps
//   JSON=1               prints the results as JSON on the last line
import { dlopen, ptr } from "bun:ffi"
import { existsSync, readFileSync } from "node:fs"
import { Show, createSignal } from "solid-js"
import { createTestRoot } from "@ghia/solid/testing"
import { decodeWireBatchForTest } from "@ghia/native/testing"
import type { HostElement } from "@ghia/solid"
import type { Message } from "../mailbox-scroll-hover/types"
import { Detail } from "./Detail"
import { SettingsDialog } from "./Settings"

const FIXTURE = process.env.FIXTURE ?? "detail"
if (FIXTURE !== "detail" && FIXTURE !== "settings") throw new Error(`FIXTURE must be detail or settings, got ${FIXTURE}`)
const MODE = process.env.MODE ?? (FIXTURE === "detail" ? "swap" : "toggle")
if (MODE !== "swap" && MODE !== "toggle") throw new Error(`MODE must be swap or toggle, got ${MODE}`)
if (FIXTURE === "settings" && MODE === "swap") throw new Error("the settings fixture has no swap mode")
const K = Number(process.env.K ?? "300")
const WARMUP = Number(process.env.WARMUP ?? "100")
const INSTRUMENT = process.env.INSTRUMENT !== "0"
const COUNT = process.env.COUNT === "1"
const PER_STEP = process.env.PER_STEP === "1"
// Bun runs JavaScriptCore's timer-driven collections from the event loop, which a loop of microtasks never lets turn.
const YIELD = process.env.YIELD === "1"
const HOLD_MS = Number(process.env.HOLD_MS ?? "0")

const libSystem = dlopen("/usr/lib/libSystem.B.dylib", { proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" } })
const rusageBuffer = new BigUint64Array(296 / 8)
const rusageView = new DataView(rusageBuffer.buffer)
const rusageAddress = ptr(rusageBuffer)
function readInstructions(): number {
  const status = libSystem.symbols.proc_pid_rusage(process.pid, 4, rusageAddress)
  if (status !== 0) throw new Error(`proc_pid_rusage failed: ${status}`)
  return Number(rusageView.getBigUint64(248, true))
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const at = (index: number) => {
    const value = sorted[index]
    if (value === undefined) throw new Error("median of no values")
    return value
  }
  return sorted.length % 2 ? at(middle) : (at(middle - 1) + at(middle)) / 2
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
const readOverhead = median(Array.from({ length: 500 }, () => -readInstructions() + readInstructions()))
const M = (value: number, digits = 3) => (value / 1e6).toFixed(digits)

const root = createTestRoot({ width: 1280, height: 800, appearance: "light" })
const renderer = root.renderer
renderer.setA11yActive(false)

// ── fixtures ────────────────────────────────────────────────────────────────────

let messages: Message[] = []
const [message, setMessage] = createSignal<Message | undefined>(undefined)
const [open, setOpen] = createSignal(false)
const [name, setName] = createSignal("Farrel Darian")
const [email] = createSignal("farrel@example.com")
const [planName] = createSignal("Pro")
const [theme] = createSignal("System")
const [storage] = createSignal("1.2 GB of 15 GB")
const [version] = createSignal("1.0.0")

if (FIXTURE === "detail") {
  const path = process.env.GHIA_BENCH_MESSAGES
  if (!path) throw new Error("GHIA_BENCH_MESSAGES must be the path of ghia-bench's data/messages.json")
  if (!existsSync(path)) throw new Error(`GHIA_BENCH_MESSAGES is ${path}, which does not exist`)
  messages = JSON.parse(readFileSync(path, "utf8")) as Message[]
  // a toggle starts unmounted, so that its first step mounts
  if (MODE === "swap") setMessage(messages[0])
}

function Fixture() {
  if (FIXTURE === "detail") {
    return (
      <div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: "#FFFFFF" }}>
        <Detail message={message()} ref={(_element: HostElement) => {}} />
      </div>
    )
  }
  return (
    <div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: "#FFFFFF" }}>
      <Show when={open()}>
        <SettingsDialog
          values={{ name, email, plan: planName, theme, storage, version }}
          onClose={() => setOpen(false)}
          onSave={() => setName("changed")}
          onToggle={() => setName("toggled")}
        />
      </Show>
    </div>
  )
}

root.render(() => <Fixture />)
renderer.clockPause()
renderer.setInlineDraws(false)
function settle() {
  for (let i = 0; i < 5; i++) {
    renderer.clockAdvance(1000 / 120)
    renderer.dispatchNativeEvents()
    renderer.drawFrame()
  }
}
settle()

// ── the queue and the renderer, wrapped to stamp ────────────────────────────────

type Queue = { createElement(id: number, type: string): void }
function findQueue(): Queue {
  const queues = Reflect.get(globalThis, Symbol.for("@ghia/native/mutation-queues")) as WeakMap<object, Set<WeakRef<Queue>>> | undefined
  const refs = queues?.get(renderer)
  if (!refs) throw new Error("no mutation queue is registered for the test renderer")
  const live = [...refs].map((ref) => ref.deref()).filter((queue): queue is Queue => queue !== undefined)
  if (live.length !== 1) throw new Error(`expected one mutation queue, found ${live.length}`)
  const only = live[0]
  if (only === undefined) throw new Error("no live mutation queue")
  return only
}

let stampFirstOp = 0
let sawFirstOp = false
let stampApplyStart = 0
let stampApplyEnd = 0
let batchCalls = 0
let currentOps: Record<string, number> = {}
let currentBytes = 0
let currentBatches = 0

if (INSTRUMENT || COUNT) {
  const queue = findQueue()
  const createElement = queue.createElement.bind(queue)
  queue.createElement = (id, type) => {
    if (!sawFirstOp) {
      sawFirstOp = true
      stampFirstOp = readInstructions()
    }
    createElement(id, type)
  }
  const target = renderer as unknown as { applyBatch: (bytes: Uint8Array) => number[] }
  const applyBatch = target.applyBatch.bind(renderer)
  target.applyBatch = (bytes) => {
    batchCalls++
    if (COUNT) {
      currentBatches++
      currentBytes += bytes.length
      for (const op of decodeWireBatchForTest(bytes)) currentOps[op[0]] = (currentOps[op[0]] ?? 0) + 1
      return applyBatch(bytes)
    }
    stampApplyStart = readInstructions()
    const result = applyBatch(bytes)
    stampApplyEnd = readInstructions()
    return result
  }
}

// ── one step ────────────────────────────────────────────────────────────────────

type Sample = {
  kind: string
  total: number
  js: number
  ops: number
  prep: number
  apply: number
  post: number
  frame: number
}

/** A named frame for `cpuprof-attr.mjs`: the samples under it are phases js and ops. */
function profilePhaseJsAndOps(write: () => void) {
  write()
}

async function step(kind: string, write: () => void): Promise<Sample> {
  sawFirstOp = false
  stampApplyStart = stampApplyEnd = 0
  const s0 = readInstructions()
  profilePhaseJsAndOps(write)
  const s1 = readInstructions()
  await Promise.resolve()
  const s2 = readInstructions()
  renderer.drawFrame()
  const s3 = readInstructions()
  if (!INSTRUMENT || COUNT) return { kind, total: s3 - s0 - readOverhead, js: 0, ops: 0, prep: 0, apply: 0, post: 0, frame: 0 }
  if (stampApplyStart === 0) throw new Error(`step ${kind} applied no batch`)
  const mounted = sawFirstOp
  return {
    kind,
    total: s3 - s0 - 3 * readOverhead,
    js: (mounted ? stampFirstOp - s0 : s1 - s0) - readOverhead,
    ops: mounted ? s1 - stampFirstOp - readOverhead : 0,
    prep: stampApplyStart - s1 - readOverhead,
    apply: stampApplyEnd - stampApplyStart - readOverhead,
    post: s2 - stampApplyEnd - readOverhead,
    frame: s3 - s2 - readOverhead,
  }
}

function writes(): [string, () => void][] {
  if (FIXTURE === "settings") return [["mount", () => setOpen(true)], ["unmount", () => setOpen(false)]]
  if (MODE === "toggle") {
    let next = 0
    return [["mount", () => setMessage(messages[process.env.SAME === "1" ? 0 : next++ % messages.length])], ["unmount", () => setMessage(undefined)]]
  }
  let next = 1
  return [["swap", () => setMessage(messages[next++ % messages.length])]]
}

const plan = writes()
const stepsPerRound = plan.length
async function run(count: number): Promise<Sample[]> {
  const samples: Sample[] = []
  for (let round = 0; round < count; round++) {
    for (const [kind, write] of plan) {
      samples.push(await step(kind, write))
      if (YIELD) await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return samples
}

// ── run ─────────────────────────────────────────────────────────────────────────

if (COUNT) {
  await run(4)
  const perKind = new Map<string, { ops: Record<string, number>; bytes: number; batches: number; steps: number }>()
  for (let round = 0; round < K; round++) {
    for (const [kind, write] of plan) {
      currentOps = {}
      currentBytes = 0
      currentBatches = 0
      await step(kind, write)
      const total = perKind.get(kind) ?? { ops: {}, bytes: 0, batches: 0, steps: 0 }
      for (const name of Object.keys(currentOps)) total.ops[name] = (total.ops[name] ?? 0) + (currentOps[name] ?? 0)
      total.bytes += currentBytes
      total.batches += currentBatches
      total.steps++
      perKind.set(kind, total)
    }
  }
  for (const [kind, total] of perKind) {
    const ops = Object.entries(total.ops).map(([name, count]) => `${name} ${(count / total.steps).toFixed(1)}`)
    const sum = Object.values(total.ops).reduce((a, b) => a + b, 0)
    console.log(`${FIXTURE}/${kind} per step over ${total.steps}: ${(total.batches / total.steps).toFixed(2)} batch, ${(total.bytes / total.steps).toFixed(0)} wire bytes, ${(sum / total.steps).toFixed(1)} ops: ${ops.join(", ")}`)
  }
  root.unmount()
  process.exit(0)
}

await run(WARMUP)
if (process.env.PRE_GC === "1") Bun.gc(true)
if (HOLD_MS > 0) await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
if (process.env.MARK === "1") console.error("=== measured start")
const instructionsBefore = readInstructions()
const samples = await run(K)
const instructionsAll = readInstructions() - instructionsBefore
if (process.env.MARK === "1") console.error("=== measured end")

console.log(`fixture ${FIXTURE} mode ${MODE}: ${K} measured rounds (${stepsPerRound} step kind(s)) after ${WARMUP} warmup, instrument ${INSTRUMENT}, read overhead ${readOverhead.toFixed(0)}, pid ${process.pid}`)
type PhaseStats = Record<string, { mean: number; median: number }>
const results: Record<string, PhaseStats> = {}
const phases = INSTRUMENT ? ["js", "ops", "prep", "apply", "post", "frame", "total"] : ["total"]
for (const [kind] of plan) {
  const own = samples.filter((sample) => sample.kind === kind)
  const stats: PhaseStats = {}
  results[kind] = stats
  const cells: string[] = []
  for (const phase of phases) {
    const values = own.map((sample) => sample[phase as keyof Sample] as number)
    stats[phase] = { mean: mean(values), median: median(values) }
    cells.push(`${phase} ${M(mean(values))} (med ${M(median(values))})`)
  }
  console.log(`  ${kind.padEnd(8)} M instr per step, mean: ${cells.join(" | ")}`)
  if (PER_STEP) console.log(`    totals (M): ${own.map((sample) => M(sample.total, 2)).join(" ")}`)
}
console.log(`  process instructions over the measured steps: ${M(instructionsAll, 1)}M (${M(instructionsAll / samples.length)}M per step, incl. the stamps and the awaits)`)
if (process.env.JSON === "1") console.log(JSON.stringify({ fixture: FIXTURE, mode: MODE, k: K, warmup: WARMUP, instrument: INSTRUMENT, results }))
root.unmount()
process.exit(0)
