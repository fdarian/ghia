// Profiling proxy for ghia-bench's Scroll and Hover phases on the test renderer, in the way of the profile-*.tsx files of
// examples/. App.tsx and types.ts are the bench app's mailbox, verbatim, and the messages are the bench's data.
//
// Run, from examples/ (Solid's JSX is compiled by the Vite config there, so `bun` on this file alone does not run it):
//   cd examples && GHIA_BENCH_MESSAGES=/path/to/ghia-bench/data/messages.json PHASE=scroll|hover|idle bun run profile-mailbox
// Use a release addon (`bun run build` in packages/native). A tick is 1000/120 ms: one input (none in idle), then clockAdvance +
// dispatchNativeEvents + drawFrame, the way a display link ends a frame (inline draws are off; drawFrame paints only a dirty
// window). Instructions are the process's ri_instructions, which include native threads.
//
// Env of the profile:
//   APP=stack     measures ghia-bench's "Solid stack" app (../mailbox-stack: StyleX and @tanstack/solid-virtual, a div scroller rather
//                 than <virtual-list>) with its StyleX stylesheet in a <style>, as its main.tsx renders it, instead of the plain
//                 mailbox of ./App.tsx (APP=plain, the default). The scroll point, the hover column and the row height are the
//                 bench's for both. The list is then found as the scrolling ancestor of the element at the scroll point, and the
//                 `visibleRange` event, which only <virtual-list> emits, stays at 0. SCROLLBAR, NO_ROW_HOVER, NO_FOLDER_HOVER and
//                 ROW_BG are env of ./App.tsx and do nothing for the stack app (the run prints a note if one is set)
//   GHIA_BENCH_MESSAGES  path of ghia-bench's data/messages.json (required: there is no default, the run stops without it)
//   PHASE=scroll  360 wheel events of +30 (DOM sign; the harness posts CG dy=-30) down, then 360 of -30 up, at (430,442)
//   PHASE=hover   240 moves along x=430 from y=84 to 799 and 240 back, with movement deltas
//   PHASE=idle    TICKS (default 720) ticks with no input
//   EVENTS=n      events per direction (scroll 360, hover 240)
//   LOOPS=n       runs the steps n times in one measurement (1)
//   AFTER_SCROLL=1  PHASE=hover only: first the bench's scroll phase (360 wheel events down, 360 up, one tick each) in the same window, as a bench
//                 session runs hover after scroll; the list is back at scrollTop 0 when the hover starts
//   SCROLL_DELTA  pixels of a wheel event (30)
//   SCROLL_X / SCROLL_Y   where the wheel and the pointer are (430, 442)
//   TAIL_MS=500   ticks without input after the last event, reported separately (0 turns it off)
//   WHEEL_PHASE=moved  gesture phase of each wheel; AppKit reports a phaseless wheel to GPUI as "moved", a bare simulate call is "started"
//   RAW=1         only the loops: no counters, no event wrappers, no per-stage reads (for `sample` and `bun --cpu-prof`)
//   SPLIT=1       times the native simulate call and the JS dispatch of its events apart (the input stage otherwise is one call)
//   LOOP_LOG=1    RAW only: reads the counter around each tick and prints, per loop, its instructions and the median of its row crossings (a flat series is a regime that does not drift)
//   HOLD_MS=0     waits before the loop (time to attach `sample`)
//   JSON=1        also prints the aggregates as JSON
//   DUMP_TICKS=file   the scrollPatch counters of each tick, as JSON lines (DUMP_ALL=1: every counter, and the instructions of each stage)
//   A11Y=0        takes the pretend screen reader the test window starts with away (as a bench run has none)
//   ACTIVE=1      the window is key and the search input is focused, so its caret blinks (the executor's clock moves with each tick);
//                 DEBUG_BLINK=1 prints the patch counters across six blinks
// Env of App.tsx, which change the app being measured:
//   SCROLLBAR=none  the list has no scrollbar (scrollbarWidth: 'none'), so a frame is not a `Thumb`
//   NO_ROW_HOVER=1  the message rows have no hover style; NO_FOLDER_HOVER=1  the folders have none; ROW_BG=1  rows have a white background
import { dlopen, ptr } from "bun:ffi"
import { existsSync, readFileSync } from "node:fs"
import { createTestRoot, type TestElement } from "@ghia/solid/testing"
import type { Message } from "./types"

const MESSAGES_PATH = process.env.GHIA_BENCH_MESSAGES
if (!MESSAGES_PATH) throw new Error("GHIA_BENCH_MESSAGES must be the path of ghia-bench's data/messages.json")
if (!existsSync(MESSAGES_PATH)) throw new Error(`GHIA_BENCH_MESSAGES is ${MESSAGES_PATH}, which does not exist`)
const APP = process.env.APP ?? "plain"
if (APP !== "plain" && APP !== "stack") throw new Error(`APP must be plain or stack, got ${APP}`)
const PHASE = process.env.PHASE ?? "scroll"
if (PHASE !== "scroll" && PHASE !== "hover" && PHASE !== "idle") throw new Error(`PHASE must be scroll, hover or idle, got ${PHASE}`)
const RAW = process.env.RAW === "1"
const SPLIT = process.env.SPLIT === "1"
const HOLD_MS = Number(process.env.HOLD_MS ?? "0")
const TAIL_MS = Number(process.env.TAIL_MS ?? "500")
const WHEEL_PHASE = (process.env.WHEEL_PHASE ?? "moved") as "started" | "moved" | "ended" | "cancelled"
const EVENTS = Number(process.env.EVENTS ?? (PHASE === "hover" ? "240" : "360"))
const TICKS = Number(process.env.TICKS ?? String(360 * 2))
const TICK_MS = 1000 / 120
const WINDOW = { width: 1280, height: 800 }
const SCROLL_AT = { x: Number(process.env.SCROLL_X ?? "430"), y: Number(process.env.SCROLL_Y ?? "442") }
const SCROLL_DELTA = Number(process.env.SCROLL_DELTA ?? "30")
const HOVER_X = 430
const HOVER_FROM = 84
const HOVER_TO = 799
const ROW_HEIGHT = 72

// <sys/resource.h>: offsetof(struct rusage_info_v4, ri_instructions) = 248, sizeof = 296.
const RUSAGE_INFO_V4 = 4
const RI_INSTRUCTIONS = 248
const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
})
const rusageBuffer = new BigUint64Array(296 / 8)
const rusageView = new DataView(rusageBuffer.buffer)
const rusageAddress = ptr(rusageBuffer)
function readInstructions(): number {
  const status = libSystem.symbols.proc_pid_rusage(process.pid, RUSAGE_INFO_V4, rusageAddress)
  if (status !== 0) throw new Error(`proc_pid_rusage failed: ${status}`)
  return Number(rusageView.getBigUint64(RI_INSTRUCTIONS, true))
}

type Numbers = Record<string, number>
const median = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: number[]) => (values.length ? sum(values) / values.length : 0)

// Two reads in a row measure what a stage's own pair of reads adds to it.
const readOverhead = (() => {
  const deltas: number[] = []
  for (let i = 0; i < 200; i++) {
    const a = readInstructions()
    const b = readInstructions()
    deltas.push(b - a)
  }
  return median(deltas)
})()

// Imported by the app chosen only: the stack app's StyleX files are not transformed in a plain run.
const Mailbox =
  APP === "stack" ? (await import("../mailbox-stack/stack")).StackApp : (await import("./App")).App
if (APP === "stack") {
  const ignored = ["SCROLLBAR", "NO_ROW_HOVER", "NO_FOLDER_HOVER", "ROW_BG"].filter((name) => process.env[name] !== undefined)
  if (ignored.length > 0) console.error(`note: ${ignored.join(", ")} is env of the plain App.tsx and does nothing for APP=stack`)
}

const messages = JSON.parse(readFileSync(MESSAGES_PATH, "utf8")) as Message[]
const root = createTestRoot({ ...WINDOW, appearance: "light" })
const renderer = root.renderer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const native = (renderer as any).native as {
  drainEvents(): Array<{ eventType: string }>
  simulateScrollWheel(x: number, y: number, dx: number, dy: number, modifiers?: string, phase?: string): void
  simulateMouseMove(x: number, y: number, modifiers?: string, movementX?: number, movementY?: number): void
}

if (process.env.A11Y === "0") renderer.setA11yActive(false)
const mountStart = performance.now()
root.render(() => <Mailbox messages={messages} />)
const mountMs = performance.now() - mountStart
renderer.clockPause()
renderer.setInlineDraws(false)

// Counted from the first call, so the settle's events are in the totals too; each tick reads and resets them.
const emitted = new Map<string, number>()
const batches = { calls: 0, bytes: 0 }
if (!RAW) {
  const drain = native.drainEvents.bind(native)
  native.drainEvents = () => {
    const events = drain()
    for (const event of events) emitted.set(event.eventType, (emitted.get(event.eventType) ?? 0) + 1)
    return events
  }
  const target = renderer as unknown as { applyBatch: (bytes: Uint8Array) => number[] }
  const apply = target.applyBatch
  target.applyBatch = (bytes) => {
    batches.calls++
    batches.bytes += bytes.length
    return apply(bytes)
  }
}

// The caret's timer runs on the executor's clock, which clockAdvance does not move.
const advanceExecutor = (ms: number) => {
  if (process.env.ACTIVE === "1") renderer.advanceTime(ms)
}

function frameStep(ms: number) {
  renderer.clockAdvance(ms)
  advanceExecutor(ms)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

// Settle: a few frames, the clock advanced past startup work (timers, animations, scrollbar fades), then frames until
// nothing paints for a second of ticks.
for (let i = 0; i < 5; i++) frameStep(TICK_MS)
renderer.clockAdvance(3000)
renderer.dispatchNativeEvents()
for (let i = 0; i < 5; i++) frameStep(TICK_MS)
{
  let quiet = 0
  for (let i = 0; i < 600 && quiet < 120; i++) {
    const before = renderer.getPaintedFrameCount()
    frameStep(TICK_MS)
    quiet = renderer.getPaintedFrameCount() === before ? quiet + 1 : 0
  }
  if (quiet < 120) throw new Error("the window still paints after 600 ticks of settling")
}

if (process.env.ACTIVE === "1") {
  // The caret of the autofocused search input blinks only while the window is key.
  renderer.setWindowActive(true)
  const input = renderer.findByType("input")[0]
  if (!input) throw new Error("no <input> in the app")
  renderer.focusElement(input.id)
  for (let i = 0; i < 20; i++) frameStep(TICK_MS)
  if (process.env.DEBUG_BLINK === "1") {
    console.error("focused", JSON.stringify(renderer.getFocusedElementId()), "input", input.id)
    const before = renderer.getPatchCounters()
    for (let i = 0; i < 6; i++) { renderer.advanceTime(500) }
    console.error("blink", JSON.stringify(before), JSON.stringify(renderer.getPatchCounters()))
  }
}

// The message list: the plain app's <virtual-list>, and for the stack app the nearest scrolling ancestor of what is at the scroll
// point (the list is a div with overflow-y: auto, so its type says nothing).
function findList(): TestElement {
  if (APP === "plain") {
    const virtualList = renderer.findByType("virtual-list")[0]
    if (!virtualList) throw new Error("no <virtual-list> in the app")
    return virtualList
  }
  for (const hit of renderer.getElementsAt(SCROLL_AT.x, SCROLL_AT.y)) {
    for (let element = renderer.getElement(hit); element; element = element.parentId === null ? undefined : renderer.getElement(element.parentId)) {
      const metrics = renderer.getScrollMetrics(element.id)
      // [scrollLeft, scrollTop, scrollWidth, scrollHeight, clientWidth, clientHeight]
      if (metrics && metrics[3]! > metrics[5]!) return element
    }
  }
  throw new Error(`no scrolling element at (${SCROLL_AT.x}, ${SCROLL_AT.y}), so no message list for APP=stack`)
}
const list = findList()
const scrollTop = () => renderer.getScrollMetrics(list.id)![1]!

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

function diffCounters(before: Numbers, after: Numbers): Numbers {
  const delta: Numbers = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[key] ?? 0) - (before[key] ?? 0)
    if (change !== 0) delta[key] = change
  }
  return delta
}

interface Tick {
  label: string
  category: string
  inputInstr: number
  /** SPLIT=1 only: the native simulate call, of which the rest of `inputInstr` is the JS dispatch. */
  nativeInstr: number
  clockInstr: number
  drawInstr: number
  paintedInput: number
  paintedClock: number
  paintedDraw: number
  passesInput: number
  passesClock: number
  passesDraw: number
  counters: Numbers
  emitted: Numbers
  batchCalls: number
  batchBytes: number
}

interface Step {
  label: string
  category: (tick: Tick) => string
  input: (() => void) | null
  /** Replaces the whole input stage (SPLIT=1 times the native call apart). */
  nativeInput?: () => void
}

function runTick(step: Step): Tick {
  const tick: Tick = {
    label: step.label,
    category: "",
    inputInstr: 0,
    nativeInstr: 0,
    clockInstr: 0,
    drawInstr: 0,
    paintedInput: 0,
    paintedClock: 0,
    paintedDraw: 0,
    passesInput: 0,
    passesClock: 0,
    passesDraw: 0,
    counters: {},
    emitted: {},
    batchCalls: 0,
    batchBytes: 0,
  }
  const paintedBefore = renderer.getPaintedFrameCount()
  const passesBefore = renderer.getLayoutPassCount()
  const countersBefore = snapshotCounters()
  emitted.clear()
  batches.calls = 0
  batches.bytes = 0

  if (step.input) {
    if (SPLIT && step.nativeInput) {
      const a = readInstructions()
      step.nativeInput()
      const b = readInstructions()
      renderer.dispatchNativeEvents()
      const c = readInstructions()
      tick.nativeInstr = b - a - readOverhead
      tick.inputInstr = c - a - 2 * readOverhead
    } else {
      const a = readInstructions()
      step.input()
      const b = readInstructions()
      tick.inputInstr = b - a - readOverhead
    }
  }
  const paintedInput = renderer.getPaintedFrameCount()
  const passesInput = renderer.getLayoutPassCount()

  const c0 = readInstructions()
  renderer.clockAdvance(TICK_MS)
  advanceExecutor(TICK_MS)
  renderer.dispatchNativeEvents()
  const c1 = readInstructions()
  tick.clockInstr = c1 - c0 - readOverhead
  const paintedClock = renderer.getPaintedFrameCount()
  const passesClock = renderer.getLayoutPassCount()

  const d0 = readInstructions()
  renderer.drawFrame()
  const d1 = readInstructions()
  tick.drawInstr = d1 - d0 - readOverhead

  tick.paintedInput = paintedInput - paintedBefore
  tick.paintedClock = paintedClock - paintedInput
  tick.paintedDraw = renderer.getPaintedFrameCount() - paintedClock
  tick.passesInput = passesInput - passesBefore
  tick.passesClock = passesClock - passesInput
  tick.passesDraw = renderer.getLayoutPassCount() - passesClock
  tick.counters = diffCounters(countersBefore, snapshotCounters())
  tick.emitted = Object.fromEntries(emitted)
  tick.batchCalls = batches.calls
  tick.batchBytes = batches.bytes
  tick.category = step.category(tick)
  return tick
}

const tickTotal = (tick: Tick) => tick.inputInstr + tick.clockInstr + tick.drawInstr
const paintedOf = (tick: Tick) => tick.paintedInput + tick.paintedClock + tick.paintedDraw
const VISIBLE_RANGE = "visibleRange"
const visibleRangeOf = (tick: Tick) => tick.emitted[VISIBLE_RANGE] ?? 0

// ── Steps ───────────────────────────────────────────────────────

const none = () => "tick"
const steps: Step[] = []
let scrollTopAfterDown: number | null = null
let scrollTopAfterUp: number | null = null

if (PHASE === "scroll") {
  const wheel = (dy: number) => () => renderer.dispatchScrollWheel(SCROLL_AT.x, SCROLL_AT.y, 0, dy, undefined, WHEEL_PHASE)
  const nativeWheel = (dy: number) => () => native.simulateScrollWheel(SCROLL_AT.x, SCROLL_AT.y, 0, dy, undefined, WHEEL_PHASE)
  const category = (tick: Tick) => (tick.batchCalls > 0 ? "mutation batch applied (window moved)" : "no mutation batch")
  for (let i = 0; i < EVENTS; i++) steps.push({ label: `down ${i}`, category, input: wheel(SCROLL_DELTA), nativeInput: nativeWheel(SCROLL_DELTA) })
  for (let i = 0; i < EVENTS; i++) steps.push({ label: `up ${i}`, category, input: wheel(-SCROLL_DELTA), nativeInput: nativeWheel(-SCROLL_DELTA) })
} else if (PHASE === "hover") {
  const stepY = (HOVER_TO - HOVER_FROM) / (EVENTS - 1)
  const category = (tick: Tick) => {
    const [from, to] = tick.label.split(" ")[1]!.split(">").map(Number) as [number, number]
    return Math.floor((from - HOVER_FROM) / ROW_HEIGHT) === Math.floor((to - HOVER_FROM) / ROW_HEIGHT) ? "same row" : "row crossing"
  }
  let previous = HOVER_FROM
  const move = (y: number) => {
    const from = previous
    previous = y
    return { label: `${from > y ? "up" : "down"} ${from.toFixed(1)}>${y.toFixed(1)}`, y, dy: y - from }
  }
  const moves = []
  for (let i = 0; i < EVENTS; i++) moves.push(move(HOVER_FROM + i * stepY))
  for (let i = 1; i <= EVENTS; i++) moves.push(move(Math.max(HOVER_FROM, HOVER_TO - i * stepY)))
  for (const m of moves) {
    steps.push({
      label: m.label,
      category,
      input: () => renderer.dispatchMouseMove(HOVER_X, m.y, undefined, { x: 0, y: m.dy }),
      nativeInput: () => native.simulateMouseMove(HOVER_X, m.y, undefined, 0, m.dy),
    })
  }
} else {
  for (let i = 0; i < TICKS; i++) steps.push({ label: `idle ${i}`, category: none, input: null })
}
const tailSteps: Step[] = []
for (let i = 0; i < Math.round(TAIL_MS / TICK_MS); i++) tailSteps.push({ label: `tail ${i}`, category: none, input: null })

// ── Pointer and starting state ──────────────────────────────────

if (PHASE === "hover" && process.env.AFTER_SCROLL === "1") {
  renderer.dispatchMouseMove(SCROLL_AT.x, SCROLL_AT.y)
  for (const dy of [SCROLL_DELTA, -SCROLL_DELTA]) {
    for (let i = 0; i < 360; i++) {
      renderer.dispatchScrollWheel(SCROLL_AT.x, SCROLL_AT.y, 0, dy, undefined, WHEEL_PHASE)
      frameStep(TICK_MS)
    }
  }
}
if (PHASE === "scroll") {
  renderer.dispatchMouseMove(SCROLL_AT.x, SCROLL_AT.y)
  for (let i = 0; i < 3; i++) frameStep(TICK_MS)
} else if (PHASE === "hover") {
  renderer.dispatchMouseMove(HOVER_X, HOVER_FROM)
  for (let i = 0; i < 3; i++) frameStep(TICK_MS)
}
for (let i = 0; i < 60; i++) frameStep(TICK_MS)
if (scrollTop() !== 0) throw new Error(`list starts at scrollTop ${scrollTop()}`)

console.error(`mounted ${messages.length} messages in ${mountMs.toFixed(0)} ms, app ${APP}, phase ${PHASE}${RAW ? " (raw)" : ""}, pid ${process.pid}, rusage read overhead ${readOverhead} instr`)
if (HOLD_MS > 0) await new Promise((resolve) => setTimeout(resolve, HOLD_MS))

// ── RAW: loops and totals only ──────────────────────────────────

const countedPainted = () => renderer.getPaintedFrameCount()

if (RAW) {
  const perTick = process.env.LOOP_LOG === "1"
  // LOOP_LOG=1 reads the counter around each tick (a read is ~10k instructions, a crossing ~3.6M) and keeps those of the ticks
  // that cross a row, so a loop reports what the normal run reports: the median instructions of a crossing.
  let crossings: number[] = []
  const run = (list: Step[]) => {
    const paintedBefore = countedPainted()
    const before = readInstructions()
    for (const step of list) {
      const tickStart = perTick ? readInstructions() : 0
      if (step.input) step.input()
      renderer.clockAdvance(TICK_MS)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      if (perTick && step.category({ label: step.label } as Tick) === "row crossing") crossings.push(readInstructions() - tickStart - readOverhead)
    }
    const after = readInstructions()
    return { instructions: after - before, painted: countedPainted() - paintedBefore }
  }
  const loopLog = (loop: number, result: { instructions: number; painted: number }) => {
    if (!perTick) return
    console.error(`loop ${loop}: ${(result.instructions / 1e6).toFixed(1)}M instr, ${crossings.length} crossings, median crossing ${(median(crossings) / 1e6).toFixed(3)}M`)
    crossings = []
  }
  let input = run(steps)
  loopLog(0, input)
  for (let loop = 1; loop < Number(process.env.LOOPS ?? '1'); loop++) {
    const more = run(steps)
    loopLog(loop, more)
    input = { instructions: input.instructions + more.instructions, painted: input.painted + more.painted }
  }
  const tail = run(tailSteps)
  console.log(
    `${PHASE} raw: ${steps.length} ticks, ${(input.instructions / 1e6).toFixed(1)}M instr (${(input.instructions / steps.length / 1e6).toFixed(3)}M per tick), ${input.painted} frames painted; tail ${tailSteps.length} ticks ${(tail.instructions / 1e6).toFixed(1)}M, ${tail.painted} painted`,
  )
  root.unmount()
  process.exit(0)
}

// ── Measured run ────────────────────────────────────────────────

const ticks: Tick[] = []
const half = PHASE === "idle" ? steps.length : steps.length / 2
steps.forEach((step, index) => {
  ticks.push(runTick(step))
  if (PHASE === "scroll" && index === half - 1) scrollTopAfterDown = scrollTop()
})
if (PHASE === "scroll") scrollTopAfterUp = scrollTop()
if (process.env.DUMP_TICKS) {
  const { writeFileSync } = await import("node:fs")
  writeFileSync(
    process.env.DUMP_TICKS,
    ticks
      .map((tick) =>
        JSON.stringify({
          ...Object.fromEntries(Object.entries(tick.counters).filter(([key]) => process.env.DUMP_ALL === "1" || key.startsWith("patch.scrollPatch"))),
          ...(process.env.DUMP_ALL === "1" ? { inputInstr: tick.inputInstr, clockInstr: tick.clockInstr, drawInstr: tick.drawInstr, batchCalls: tick.batchCalls, batchBytes: tick.batchBytes } : {}),
        }),
      )
      .join("\n"),
  )
}
const tail = tailSteps.map(runTick)
const finalTailPainted = sum(tail.map(paintedOf))

// ── Report ──────────────────────────────────────────────────────

const M = (value: number, digits = 3) => (value / 1e6).toFixed(digits)
const pad = (text: string, width: number) => text.padEnd(width)
const num = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2))

function summarize(name: string, list: Tick[]) {
  if (list.length === 0) return
  const totals = list.map(tickTotal)
  console.log(`\n[${name}] ${list.length} ticks`)
  console.log(
    `  instructions: total ${M(sum(totals), 1)}M  per tick mean ${M(mean(totals))}M  median ${M(median(totals))}M  p95 ${M([...totals].sort((a, b) => a - b)[Math.floor(totals.length * 0.95)]!)}M`,
  )
  const stage = (label: string, pick: (tick: Tick) => number) =>
    `${label} ${M(mean(list.map(pick)))}M (median ${M(median(list.map(pick)))}M)`
  console.log(`  split per tick: ${stage("input", (t) => t.inputInstr)}  ${stage("clock+dispatch", (t) => t.clockInstr)}  ${stage("drawFrame", (t) => t.drawInstr)}`)
  if (SPLIT && list[0]!.nativeInstr > 0) {
    console.log(`  input stage: ${stage("native simulate", (t) => t.nativeInstr)}  ${stage("JS dispatch+Solid", (t) => t.inputInstr - t.nativeInstr)}`)
  }
  const painted = list.map(paintedOf)
  const histogram = new Map<number, number>()
  for (const count of painted) histogram.set(count, (histogram.get(count) ?? 0) + 1)
  console.log(
    `  frames painted: ${sum(painted)} (${(sum(painted) / list.length).toFixed(3)} per tick; in input ${sum(list.map((t) => t.paintedInput))}, in clock ${sum(list.map((t) => t.paintedClock))}, in drawFrame ${sum(list.map((t) => t.paintedDraw))})  ticks by frames painted: ${[...histogram].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}:${c}`).join(" ")}`,
  )
  console.log(
    `  layout-only passes: ${sum(list.map((t) => t.passesInput + t.passesClock + t.passesDraw))} (${(sum(list.map((t) => t.passesInput + t.passesClock + t.passesDraw)) / list.length).toFixed(3)} per tick; in input ${sum(list.map((t) => t.passesInput))}, in clock ${sum(list.map((t) => t.passesClock))}, in drawFrame ${sum(list.map((t) => t.passesDraw))})`,
  )
  const types = new Set<string>()
  for (const tick of list) for (const type of Object.keys(tick.emitted)) types.add(type)
  const emittedLine = [...types].sort().map((type) => `${type} ${(sum(list.map((t) => t.emitted[type] ?? 0)) / list.length).toFixed(3)}`)
  console.log(`  native->JS events per tick: ${emittedLine.join("  ") || "none"}  (total ${sum(list.map((t) => sum(Object.values(t.emitted))))}; ${VISIBLE_RANGE} total ${sum(list.map(visibleRangeOf))})`)
  console.log(`  applyBatch per tick: ${(sum(list.map((t) => t.batchCalls)) / list.length).toFixed(3)} calls, ${(sum(list.map((t) => t.batchBytes)) / list.length).toFixed(0)} bytes`)
  const counterNames = new Set<string>()
  for (const tick of list) for (const key of Object.keys(tick.counters)) counterNames.add(key)
  if (counterNames.size === 0) console.log("  counters: no change on any tick")
  else {
    const retainKeys = [...counterNames].filter((key) => /retain/i.test(key)).sort()
    console.log("  retain reasons and retained counters per tick (mean / median / min..max):")
    if (retainKeys.length === 0) console.log("    none changed")
    for (const key of retainKeys) {
      const values = list.map((t) => t.counters[key] ?? 0)
      console.log(`    ${pad(key, 44)} ${num(mean(values)).padStart(10)} ${num(median(values)).padStart(8)}  ${Math.min(...values)}..${Math.max(...values)}`)
    }
    console.log("  all counter deltas per tick (mean / median / min..max), nonzero only:")
    for (const key of [...counterNames].sort()) {
      const values = list.map((t) => t.counters[key] ?? 0)
      console.log(`    ${pad(key, 44)} ${num(mean(values)).padStart(10)} ${num(median(values)).padStart(8)}  ${Math.min(...values)}..${Math.max(...values)}`)
    }
  }
}

console.log(`phase ${PHASE}: ${steps.length} ticks of ${TICK_MS.toFixed(3)} ms${PHASE === "idle" ? "" : `, ${EVENTS} events per direction`}`)
if (PHASE === "scroll") {
  console.log(`scrollTop after down: ${scrollTopAfterDown} (expected ${EVENTS * SCROLL_DELTA}), after up: ${scrollTopAfterUp} (expected 0)`)
}
summarize(PHASE, ticks)
if (PHASE === "scroll") {
  summarize("scroll down", ticks.slice(0, half))
  summarize("scroll up", ticks.slice(half))
}
if (PHASE !== "idle") {
  const categories = [...new Set(ticks.map((t) => t.category))]
  if (categories.length > 1) for (const category of categories) summarize(`${PHASE}: ${category}`, ticks.filter((t) => t.category === category))
}
if (PHASE === "scroll") {
  const total = (key: string) => sum(ticks.map((t) => t.counters[key] ?? 0))
  const frames = total("patch.scrollPatch.frames")
  const eligible = total("patch.scrollPatch.eligible")
  const reasons = Object.fromEntries(
    [...new Set(ticks.flatMap((t) => Object.keys(t.counters)))]
      .filter((key) => key.startsWith("patch.scrollPatch.reasons."))
      .map((key) => [key.slice("patch.scrollPatch.reasons.".length), total(key)]),
  )
  const held = Object.fromEntries(
    [...new Set(ticks.flatMap((t) => Object.keys(t.counters)))]
      .filter((key) => key.startsWith("patch.scrollPatch.held."))
      .map((key) => [key.slice("patch.scrollPatch.held.".length), total(key)]),
  )
  console.log(`scrollPatch held (every reason that held, first or not): ${JSON.stringify(held)}`)
  console.log(
    `\nscrollPatch: ${frames} classified of ${ticks.length} ticks, eligible ${eligible} (${((100 * eligible) / Math.max(frames, 1)).toFixed(1)}%), mispredicted ${total("patch.scrollPatch.mispredicted")}, hover-only ${total("patch.scrollPatch.hoverOnly")} (eligible with the pointer elsewhere ${(((eligible + total("patch.scrollPatch.hoverOnly")) * 100) / Math.max(frames, 1)).toFixed(1)}%), reasons ${JSON.stringify(reasons)}`,
  )
}
if (PHASE === "scroll") {
  const instr = (t: Tick) => t.inputInstr + t.clockInstr + t.drawInstr
  const patchedTicks = ticks.filter((t) => (t.counters["patch.scrollPatch.patched"] ?? 0) > 0)
  const wholeTicks = ticks.filter((t) => (t.counters["patch.scrollPatch.patched"] ?? 0) === 0)
  const declines = Object.fromEntries(
    [...new Set(ticks.flatMap((t) => Object.keys(t.counters)))]
      .filter((key) => key.startsWith("patch.scrollPatch.applyDeclines."))
      .map((key) => [key.slice("patch.scrollPatch.applyDeclines.".length), sum(ticks.map((t) => t.counters[key] ?? 0))]),
  )
  const total = (key: string) => sum(ticks.map((t) => t.counters[key] ?? 0))
  const membershipTicks = ticks.filter((t) => (t.counters["patch.scrollPatch.membershipFrames"] ?? 0) > 0)
  console.log(
    `scrollPatch membership translates ${membershipTicks.length} of ${ticks.length} ticks (rows built ${total("patch.scrollPatch.rowsBuilt")}, rows removed ${total("patch.scrollPatch.rowsRemoved")}), median ${(median(membershipTicks.map(instr)) / 1e6).toFixed(3)}M, the other patched ticks ${(mean(patchedTicks.filter((t) => !membershipTicks.includes(t)).map(instr)) / 1e6).toFixed(3)}M`,
  )
  console.log(
    `scrollPatch patched ${patchedTicks.length} of ${ticks.length} ticks, applyDeclines ${JSON.stringify(declines)}; instructions per tick: mean ${(mean(ticks.map(instr)) / 1e6).toFixed(3)}M, patched ticks ${(mean(patchedTicks.map(instr)) / 1e6).toFixed(3)}M, other ticks ${(mean(wholeTicks.map(instr)) / 1e6).toFixed(3)}M`,
  )
}
{
  const instr = (t: Tick) => t.inputInstr + t.clockInstr + t.drawInstr
  const patched = ticks.filter((t) => (t.counters["patch.patchedFrames"] ?? 0) > 0)
  const rest = ticks.filter((t) => (t.counters["patch.patchedFrames"] ?? 0) === 0)
  const total = (key: string) => sum(ticks.map((t) => t.counters[key] ?? 0))
  console.log(
    `patchedFrames ${patched.length} of ${ticks.length} ticks: ${(mean(patched.map(instr)) / 1e6).toFixed(3)}M per patched tick (drawFrame ${(mean(patched.map((t) => t.drawInstr)) / 1e6).toFixed(3)}M), other ticks ${(mean(rest.map(instr)) / 1e6).toFixed(3)}M, total ${(sum(ticks.map(instr)) / 1e6).toFixed(2)}M; sceneRebuilds ${total("patch.sceneRebuilds")} inPlacePrimitives ${total("patch.inPlacePrimitives")}`,
  )
}
summarize("tail after input", tail)
console.log(`\nframes painted in the tail: ${finalTailPainted}`)

if (process.env.JSON === "1") console.log(JSON.stringify({ phase: PHASE, ticks, tail }))
root.unmount()
process.exit(0)
