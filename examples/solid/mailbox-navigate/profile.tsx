// Profiling proxy for ghia-bench's Navigate phase (30 x ArrowDown, 120 ms apart) on the test renderer.
// App.tsx and types.ts are the bench app's mailbox plus phase-timer hooks (`phaseRun`); the App-*.tsx files are one-line experiments on it.
// Run, from examples/ (Solid's JSX is compiled by the Vite config there, so `bun` on this file alone does not run it):
//   cd examples && GHIA_BENCH_MESSAGES=/path/to/ghia-bench/data/messages.json A11Y=0 bun run profile-navigate
// Env: GHIA_BENCH_MESSAGES  path of ghia-bench's data/messages.json (required; the run stops without it)
//   A11Y=0  takes the pretend screen reader the test window starts with away (as a bench run has none)
//   KEYS=30, KEYS_ONLY=1 (no per-key counters/verification, for --cpu-prof / sample), HOLD_MS=0, JSON=1
//   PHASES=1  adds a per-phase table (median instructions per key, exclusive of nested phases) and, unless
//             PHASE_COUNTERS=0, the median counter deltas of each phase. Counter reads sit outside the timed intervals.
//   PHASE_WRAP=all|name,name  wraps those renderer methods as phases ("native:<name>"); default applyBatch,getScrollMetrics
//   VERIFY=0  does not check that the detail follows the selection (for the App variants whose detail is static)
//   TRACE_KEY=n  prints the ordered phase events (with painted frames / layout passes) of key n
//   APP=App|App-noreveal|App-revealfirst|App-rowsstatic|App-detailhidden|App-detailstatic|App-allstatic  picks the app variant
//   SHOT_DIR=dir SHOT_KEYS=52,70  writes the frame shown after those keys to dir/key-N.png
//   PHASES_OUT=path  writes the raw per-key phase data as JSON
import { dlopen, ptr } from "bun:ffi"
import { existsSync, readFileSync } from "node:fs"
import { createTestRoot } from "@ghia/solid/testing"
import { decodeWireBatchForTest } from "@ghia/native/testing"
import { writeFileSync } from "node:fs"
import type { Message } from "./types"

const APP = process.env.APP ?? "App"
const PHASES = process.env.PHASES === "1"
const PHASE_COUNTERS = PHASES && process.env.PHASE_COUNTERS !== "0"
// Experiments: SKIP_FLUSH=1 leaves out native.flushIfDirty() before the key; DRAW_AT_END=1 draws one more frame at 120 ms.
const SKIP_FLUSH = process.env.SKIP_FLUSH === "1"
// CONSUME_UNFLUSHED=1 reads one element's bounds at 120 ms; the read takes the pending-mutation flag that flushIfDirty would turn into an invalidation.
const CONSUME_UNFLUSHED = process.env.CONSUME_UNFLUSHED === "1"
const DRAW_AT_END = process.env.DRAW_AT_END === "1"
const RETAIN_DEBUG_KEY = Number(process.env.RETAIN_DEBUG_KEY ?? "0") // needs GPUIX_RETAIN_DEBUG=1
const VERIFY = process.env.VERIFY !== "0"
// SHOT_DIR=dir SHOT_KEYS=52,70,120 writes the frame shown after each of those keys to dir/key-N.png, outside the timed key.
const SHOT_DIR = process.env.SHOT_DIR
const SHOT_KEYS = (process.env.SHOT_KEYS ?? "").split(",").filter(Boolean).map(Number)
const TRACE_KEY = Number(process.env.TRACE_KEY ?? "0")

const MESSAGES_PATH = process.env.GHIA_BENCH_MESSAGES
if (!MESSAGES_PATH) throw new Error("GHIA_BENCH_MESSAGES must be the path of ghia-bench's data/messages.json")
if (!existsSync(MESSAGES_PATH)) throw new Error(`GHIA_BENCH_MESSAGES is ${MESSAGES_PATH}, which does not exist`)
const KEYS = Number(process.env.KEYS ?? "30")
const KEYS_ONLY = process.env.KEYS_ONLY === "1"
const HOLD_MS = Number(process.env.HOLD_MS ?? "0")
const FRAME_MS = 1000 / 120
const KEY_PERIOD_MS = 120
const KEY_UP_AT_MS = 15

// <sys/resource.h>: offsetof(struct rusage_info_v4, ri_instructions) = 248, ri_cycles = 256, sizeof = 296 (checked with clang).
const RUSAGE_INFO_V4 = 4
const RI_INSTRUCTIONS = 248
const RI_CYCLES = 256
const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
})
const rusageBuffer = new BigUint64Array(296 / 8)
const rusageView = new DataView(rusageBuffer.buffer)

function readRusage() {
  const status = libSystem.symbols.proc_pid_rusage(process.pid, RUSAGE_INFO_V4, ptr(rusageBuffer))
  if (status !== 0) throw new Error(`proc_pid_rusage failed: ${status}`)
  return {
    instructions: Number(rusageView.getBigUint64(RI_INSTRUCTIONS, true)),
    cycles: Number(rusageView.getBigUint64(RI_CYCLES, true)),
  }
}

function readInstructions() {
  const status = libSystem.symbols.proc_pid_rusage(process.pid, RUSAGE_INFO_V4, ptr(rusageBuffer))
  if (status !== 0) throw new Error(`proc_pid_rusage failed: ${status}`)
  return Number(rusageView.getBigUint64(RI_INSTRUCTIONS, true))
}
;(globalThis as unknown as { readRusage: typeof readRusage }).readRusage = readRusage

type Numbers = Record<string, number>

interface PhaseAcc {
  instr: number
  calls: number
  counters: Numbers
}
interface PhaseFrame {
  name: string
  startT: number
  startCounters: Numbers | undefined
  childInstr: number
  childCounters: Numbers
}

// Nested phases are exclusive: a phase's instructions are its own minus its children's. The cost of the
// bookkeeping itself (two rusage reads and, with counters, a counter snapshot per phase edge) is added to
// `overhead` and subtracted from the clock, so it is in no phase.
const phase = {
  recording: false,
  bypass: 0,
  overhead: 0,
  stack: [] as PhaseFrame[],
  current: new Map<string, PhaseAcc>(),
  events: [] as string[],
  snapshot: (() => ({})) as () => Numbers,
  trace(line: string) {
    phase.bypass++
    phase.events.push(`${line}  painted=${renderer.getPaintedFrameCount()} passes=${renderer.getLayoutPassCount()}`)
    phase.bypass--
  },
  edge(): { t: number; counters: Numbers | undefined } {
    phase.bypass++
    const raw0 = readInstructions()
    const counters = PHASE_COUNTERS ? phase.snapshot() : undefined
    const raw1 = readInstructions()
    phase.bypass--
    const t = raw0 - phase.overhead
    phase.overhead += raw1 - raw0
    return { t, counters }
  },
  run<T>(name: string, fn: () => T): T {
    if (process.env.GPUIX_LAZY_LOG) console.error("[phase]", name)
    if (!phase.recording || phase.bypass > 0) return fn()
    const start = phase.edge()
    phase.stack.push({ name, startT: start.t, startCounters: start.counters, childInstr: 0, childCounters: {} })
    if (TRACE_KEY) phase.trace(`${"  ".repeat(phase.stack.length - 1)}> ${name}`)
    try {
      return fn()
    } finally {
      const end = phase.edge()
      const frame = phase.stack.pop()!
      const inclusive = end.t - frame.startT
      const exclusive = inclusive - frame.childInstr
      const inclusiveCounters = end.counters && frame.startCounters ? diffCounters(frame.startCounters, end.counters) : {}
      const exclusiveCounters = { ...inclusiveCounters }
      for (const [key, value] of Object.entries(frame.childCounters)) exclusiveCounters[key] = (exclusiveCounters[key] ?? 0) - value
      const parent = phase.stack.at(-1)
      if (parent) {
        parent.childInstr += inclusive
        for (const [key, value] of Object.entries(inclusiveCounters)) parent.childCounters[key] = (parent.childCounters[key] ?? 0) + value
      }
      let acc = phase.current.get(frame.name)
      if (!acc) phase.current.set(frame.name, (acc = { instr: 0, calls: 0, counters: {} }))
      acc.instr += exclusive
      acc.calls++
      for (const [key, value] of Object.entries(exclusiveCounters)) if (value !== 0) acc.counters[key] = (acc.counters[key] ?? 0) + value
      if (TRACE_KEY) phase.trace(`${"  ".repeat(phase.stack.length)}< ${frame.name}  excl=${(exclusive / 1e6).toFixed(2)}M`)
    }
  },
}
;(globalThis as unknown as { __phase?: typeof phase }).__phase = PHASES ? phase : undefined
const run = PHASES ? phase.run : <T,>(_name: string, fn: () => T) => fn()

const appModule = (await import(`./${APP}`)) as { App: (props: { messages: Message[] }) => unknown }
const App = appModule.App
const messages = JSON.parse(readFileSync(MESSAGES_PATH, "utf8")) as Message[]
const root = createTestRoot({ width: 1280, height: 800, appearance: "light" })
const renderer = root.renderer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const native = (renderer as any).native as {
  flushIfDirty(): void
  simulateKeyDown(keystroke: string, isHeld?: boolean): void
  simulateKeyUp(keystroke: string): void
}

if (process.env.A11Y === "0") renderer.setA11yActive(false)
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

let focusedId = renderer.getFocusedElementId()
const inputId = renderer.findByType("input")[0]!.id
if (focusedId !== inputId) {
  renderer.focusElement(inputId)
  for (let i = 0; i < 2; i++) frameStep(FRAME_MS)
  focusedId = renderer.getFocusedElementId()
}
if (focusedId !== inputId) throw new Error(`search input ${inputId} is not focused (focused: ${focusedId})`)

// The detail is the last place in tree order that shows the subject, and the only one whose
// header block also holds the sender's email; a list row with the same subject does not.
function detailShows(message: Message): boolean {
  const title = renderer
    .findByType("text")
    .filter((element) => element.text === message.subject)
    .at(-1)
  // The match is the raw text node inside the <text> element, so the header block is two levels up.
  const titleElement = title?.parentId == null ? undefined : renderer.getElement(title.parentId)
  if (!titleElement || titleElement.parentId == null) return false
  const texts: Array<string | null> = []
  const collect = (id: number) => {
    const element = renderer.getElement(id)!
    texts.push(element.text)
    element.children.forEach(collect)
  }
  collect(titleElement.parentId)
  return texts.includes(message.fromEmail)
}
if (!detailShows(messages[0]!)) throw new Error("initial detail does not show message 0")

if (!KEYS_ONLY) console.error(`mounted ${messages.length} messages in ${mountMs.toFixed(0)} ms, input ${inputId} focused, pid ${process.pid}`)
else console.error(`pid ${process.pid}`)
if (HOLD_MS > 0) await new Promise((resolve) => setTimeout(resolve, HOLD_MS))

function flatten(prefix: string, value: unknown, out: Numbers) {
  if (typeof value === "number") out[prefix] = value
  else if (typeof value === "string" && value !== "") {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      return
    }
    if (parsed && typeof parsed === "object") {
      for (const [key, inner] of Object.entries(parsed)) flatten(`${prefix}.${key}`, inner, out)
    } else if (typeof parsed === "number") out[prefix] = parsed
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) flatten(`${prefix}.${key}`, inner, out)
  }
}

function snapshotCounters(): Numbers {
  const out: Numbers = {}
  flatten("build", renderer.getBuildCounters(), out)
  flatten("retained", renderer.getRetainedCounters(), out)
  flatten("frameWork", renderer.getFrameWorkCounters(), out)
  flatten("layout", renderer.getLayoutCounters(), out)
  flatten("patch", renderer.getPatchCounters(), out)
  out["layoutPasses"] = renderer.getLayoutPassCount()
  return out
}

function summarizeBatch(bytes: Uint8Array): string {
  const ops = decodeWireBatchForTest(bytes)
  const counts = new Map<string, number>()
  for (const op of ops) counts.set(op[0], (counts.get(op[0]) ?? 0) + 1)
  const sample = ops.length <= 4 ? " " + JSON.stringify(ops).slice(0, 400) : ""
  return `${ops.length} ops: ${[...counts].map(([name, count]) => `${name}x${count}`).join(" ")}${sample}`
}

function phaseSnapshot(): Numbers {
  const out = snapshotCounters()
  out["paintedFrames"] = renderer.getPaintedFrameCount()
  return out
}
phase.snapshot = phaseSnapshot

if (PHASES) {
  const wrapSpec = process.env.PHASE_WRAP ?? "applyBatch,getScrollMetrics,dispatchSyncEvent,scrollTo"
  const skip = new Set(["constructor", "getPaintedFrameCount", "getLayoutPassCount", "getBuildCounters", "getRetainedCounters", "getFrameWorkCounters", "getLayoutCounters", "getPatchCounters", "resetBuildCounters"])
  const names = new Set<string>()
  if (wrapSpec === "all") {
    for (let proto = renderer as object; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (!skip.has(name) && typeof (renderer as unknown as Record<string, unknown>)[name] === "function") names.add(name)
      }
    }
  } else for (const name of wrapSpec.split(",")) names.add(name)
  const target = renderer as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of names) {
    const original = target[name]!.bind(renderer)
    target[name] = (...args) => {
      if (TRACE_KEY && phase.recording && name === "applyBatch") phase.trace(`    [applyBatch ${summarizeBatch(args[0] as Uint8Array)}]`)
      return phase.run(`native:${name}`, () => original(...args))
    }
  }
}

function diffCounters(before: Numbers, after: Numbers): Numbers {
  const delta: Numbers = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[key] ?? 0) - (before[key] ?? 0)
    if (change !== 0) delta[key] = change
  }
  return delta
}

interface KeyResult {
  index: number
  instructions: number
  cycles: number
  cpuMs: number
  wallMs: number
  inputMs: number
  drawMs: number
  painted: number
  paintedAt: string[]
  counters: Numbers
}

const results: KeyResult[] = []
const phaseResults: Array<Map<string, PhaseAcc>> = []
const phaseOverheads: number[] = []
let overheadAtKeyStart = 0
renderer.resetBuildCounters()

for (let index = 0; index < KEYS; index++) {
  const countersBefore = KEYS_ONLY ? {} : snapshotCounters()
  const paintedBefore = renderer.getPaintedFrameCount()
  let inputMs = 0
  let drawMs = 0
  const paintedAt: string[] = []
  let lastPainted = paintedBefore

  const timed = (kind: "input" | "draw", fn: () => void) => {
    const start = performance.now()
    fn()
    const elapsed = performance.now() - start
    if (kind === "input") inputMs += elapsed
    else drawMs += elapsed
  }
  // A scroll or bounds read inside the key handler draws on the spot, so draws are attributed to the call that caused them.
  const noteDraw = (label: string) => {
    const now = renderer.getPaintedFrameCount()
    if (now !== lastPainted) paintedAt.push(now - lastPainted === 1 ? label : `${label}x${now - lastPainted}`)
    lastPainted = now
  }

  phase.current = new Map()
  phase.events = []
  overheadAtKeyStart = phase.overhead
  phase.recording = PHASES

  const cpuBefore = process.cpuUsage()
  const rusageBefore = readRusage()
  const wallBefore = performance.now()

  timed("input", () => {
    if (!SKIP_FLUSH) run("1 flushIfDirty", () => native.flushIfDirty())
    run("1b dispatchNativeEvents (pre-key)", () => renderer.dispatchNativeEvents())
    run("2 simulateKeyDown (excl. handler + nested native)", () => native.simulateKeyDown("ArrowDown"))
    run("2b dispatchNativeEvents (post-key)", () => renderer.dispatchNativeEvents())
  })
  noteDraw("down-handler@0")
  if (RETAIN_DEBUG_KEY === index + 1) console.error("retainDebug after pre-draw+handler:", (native as unknown as { getRetainDebug(): string }).getRetainDebug())
  timed("draw", () => run("5 drawFrame@0", () => renderer.drawFrame()))
  noteDraw("frame@0")
  if (RETAIN_DEBUG_KEY === index + 1) console.error("retainDebug after drawFrame@0:", (native as unknown as { getRetainDebug(): string }).getRetainDebug())

  let elapsed = 0
  let keyUpSent = false
  for (let frame = 1; elapsed < KEY_PERIOD_MS - 1e-6; frame++) {
    const frameAt = Math.min(frame * FRAME_MS, KEY_PERIOD_MS)
    if (!keyUpSent && KEY_UP_AT_MS <= frameAt) {
      run("6 clockAdvance", () => renderer.clockAdvance(KEY_UP_AT_MS - elapsed))
      elapsed = KEY_UP_AT_MS
      timed("input", () => {
        run("6 keyup dispatchNativeEvents", () => renderer.dispatchNativeEvents())
        run("6 simulateKeyUp", () => native.simulateKeyUp("ArrowDown"))
        run("6 keyup dispatchNativeEvents", () => renderer.dispatchNativeEvents())
      })
      noteDraw("keyup@15")
      keyUpSent = true
    }
    if (frameAt === KEY_PERIOD_MS && frame * FRAME_MS > KEY_PERIOD_MS) {
      run("6 clockAdvance", () => renderer.clockAdvance(KEY_PERIOD_MS - elapsed))
      elapsed = KEY_PERIOD_MS
      break
    }
    run("6 clockAdvance", () => renderer.clockAdvance(frameAt - elapsed))
    elapsed = frameAt
    timed("input", () => run("6 tail dispatchNativeEvents", () => renderer.dispatchNativeEvents()))
    noteDraw(`dispatch@${frameAt.toFixed(1)}`)
    timed("draw", () => run("6 tail drawFrame", () => renderer.drawFrame()))
    noteDraw(`frame@${frameAt.toFixed(1)}`)
  }

  if (DRAW_AT_END) timed("draw", () => run("7 probe drawFrame@120", () => renderer.drawFrame()))
  if (CONSUME_UNFLUSHED) run("7 probe getElementBounds", () => renderer.getElementBounds(inputId))
  noteDraw("probe@120")
  const wallMs = performance.now() - wallBefore
  const rusageAfter = readRusage()
  const cpu = process.cpuUsage(cpuBefore)
  phase.recording = false
  if (PHASES) {
    phaseResults.push(phase.current)
    phaseOverheads.push(phase.overhead - overheadAtKeyStart)
    if (TRACE_KEY === index + 1) console.error(phase.events.join("\n"))
  }

  const expected = messages[index + 1]!
  if (VERIFY && !KEYS_ONLY && !detailShows(expected)) {
    throw new Error(`key ${index + 1}: detail does not show message ${index + 1} ("${expected.subject}")`)
  }
  results.push({
    index: index + 1,
    instructions: rusageAfter.instructions - rusageBefore.instructions,
    cycles: rusageAfter.cycles - rusageBefore.cycles,
    cpuMs: (cpu.user + cpu.system) / 1000,
    wallMs,
    inputMs,
    drawMs,
    painted: renderer.getPaintedFrameCount() - paintedBefore,
    paintedAt,
    counters: KEYS_ONLY ? {} : diffCounters(countersBefore, snapshotCounters()),
  })
  if (SHOT_DIR && SHOT_KEYS.includes(index + 1)) renderer.captureShownFrame(`${SHOT_DIR}/key-${index + 1}.png`)
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

if (!VERIFY) {
  console.log("selection: not verified (VERIFY=0)")
} else if (KEYS_ONLY) {
  if (!detailShows(messages[KEYS]!)) throw new Error(`after ${KEYS} keys the detail does not show message ${KEYS}`)
  console.log(`selection: detail shows message[${KEYS}] ("${messages[KEYS]!.subject}") after ${KEYS} keys`)
} else {
  console.log(
    `selection: detail subject followed message[1]..message[${KEYS}] on every key (first "${messages[1]!.subject}", last "${messages[KEYS]!.subject}")`,
  )
}

const columns: Array<[string, (r: KeyResult) => number, number]> = [
  ["Minstr", (r) => r.instructions / 1e6, 1],
  ["Mcycles", (r) => r.cycles / 1e6, 1],
  ["cpu ms", (r) => r.cpuMs, 2],
  ["wall ms", (r) => r.wallMs, 2],
  ["input ms", (r) => r.inputMs, 2],
  ["draw ms", (r) => r.drawMs, 2],
  ["painted", (r) => r.painted, 0],
]
const pad = (text: string, width: number) => text.padStart(width)
console.log(["key", ...columns.map(([name]) => name), "painted at"].map((h, i) => (i === 0 ? pad(h, 4) : i > columns.length ? "  " + h : pad(h, 10))).join(""))
for (const result of results) {
  console.log(
    pad(String(result.index), 4) +
      columns.map(([, get, digits]) => pad(get(result).toFixed(digits), 10)).join("") +
      "  " +
      result.paintedAt.join(","),
  )
}
const warm = results.slice(1)
console.log(
  pad("med", 4) + columns.map(([, get, digits]) => pad(median(results.map(get)).toFixed(digits), 10)).join(""),
)
console.log(
  pad("med*", 4) + columns.map(([, get, digits]) => pad(median(warm.map(get)).toFixed(digits), 10)).join("") + "  (* excluding key 1)",
)
console.log(pad("sum", 4) + columns.map(([, get, digits]) => pad(sum(results.map(get)).toFixed(digits), 10)).join(""))

const lateDraws = results.filter((r) => r.paintedAt.some((at) => !/@0(x\d+)?$/.test(at)))
console.log(
  `keys with paints after the keyDown frame: ${lateDraws.length}/${results.length}` +
    (lateDraws.length ? ` e.g. key ${lateDraws[0]!.index}: ${lateDraws[0]!.paintedAt.join(",")}` : ""),
)
const shapes = new Map<string, number>()
for (const result of results) shapes.set(result.paintedAt.join(","), (shapes.get(result.paintedAt.join(",")) ?? 0) + 1)
console.log("paint patterns:", [...shapes].map(([pattern, count]) => `${count}x [${pattern}]`).join("  "))

if (!KEYS_ONLY) {
  const names = new Set<string>()
  for (const result of results) for (const name of Object.keys(result.counters)) names.add(name)
  const summary = [...names]
    .map((name) => {
      const values = results.map((r) => r.counters[name] ?? 0)
      return { name, median: median(values), total: sum(values), min: Math.min(...values), max: Math.max(...values) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  console.log("counter deltas per key (median / min..max / total over all keys), nonzero only:")
  for (const row of summary) console.log(`  ${row.name.padEnd(46)} ${String(row.median).padStart(8)}  ${row.min}..${row.max}  total ${row.total}`)
  if (!summary.some((row) => row.name.startsWith("patch."))) console.log("  patch.* (patchedFrames, declines, unpatchable): no change on any key")
  if (process.env.JSON === "1") console.log(JSON.stringify({ results }))
}

if (PHASES) {
  const warmPhases = phaseResults.slice(1)
  const names: string[] = []
  for (const key of phaseResults) for (const name of key.keys()) if (!names.includes(name)) names.push(name)
  const total = (name: string) => median(warmPhases.map((key) => key.get(name)?.instr ?? 0))
  console.log("\nphases per key, median over keys 2.." + results.length + ", instructions exclusive of nested phases (bookkeeping excluded):")
  console.log(`  ${"phase".padEnd(52)}${"Minstr".padStart(9)}${"calls".padStart(7)}${"painted".padStart(9)}${"passes".padStart(8)}`)
  for (const name of names) {
    const calls = median(warmPhases.map((key) => key.get(name)?.calls ?? 0))
    const painted = median(warmPhases.map((key) => key.get(name)?.counters["paintedFrames"] ?? 0))
    const passes = median(warmPhases.map((key) => key.get(name)?.counters["layoutPasses"] ?? 0))
    console.log(`  ${name.padEnd(52)}${(total(name) / 1e6).toFixed(2).padStart(9)}${String(calls).padStart(7)}${String(painted).padStart(9)}${String(passes).padStart(8)}`)
  }
  console.log(`  ${"sum of phases (median of per-key sums)".padEnd(52)}${(median(warmPhases.map((key) => [...key.values()].reduce((acc, value) => acc + value.instr, 0))) / 1e6).toFixed(2).padStart(9)}`)
  console.log(`  bookkeeping excluded per key (median): ${(median(phaseOverheads.slice(1)) / 1e6).toFixed(2)}M`)
  if (PHASE_COUNTERS) {
    console.log("\ncounter deltas per phase (median over keys, nonzero medians only; counters of nested phases excluded):")
    for (const name of names) {
      const counterNames = new Set<string>()
      for (const key of warmPhases) for (const counter of Object.keys(key.get(name)?.counters ?? {})) counterNames.add(counter)
      const rows = [...counterNames]
        .sort()
        .map((counter) => [counter, median(warmPhases.map((key) => key.get(name)?.counters[counter] ?? 0))] as const)
        .filter(([, value]) => value !== 0)
      if (rows.length === 0) continue
      console.log(`  [${name}]`)
      console.log("    " + rows.map(([counter, value]) => `${counter.replace(/^build\.retainReasons\./, "reason.")}=${value}`).join("  "))
    }
  }
  if (process.env.PHASES_OUT) {
    writeFileSync(
      process.env.PHASES_OUT,
      JSON.stringify(phaseResults.map((key) => Object.fromEntries(key))),
    )
  }
}

root.unmount()
process.exit(0)
