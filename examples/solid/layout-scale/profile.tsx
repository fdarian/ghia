// What a layout edit costs as live rows scale: a page with a header (an <input> and a count label) and an overflow scroller holding
// COUNTS live rows (no virtualization), on the test renderer drawing the way the display link does (`setInlineDraws(false)`, one
// `drawFrame()` per op). The hypothesis it checks: a text edit outside the scroller is a whole frame whose cost grows with N, while a
// paint-only change (a hover) stays flat.
//
// Run, from examples/ (its Vite config compiles the Solid files), with a release addon built with test support:
//   cd examples && ~/.claude/notes/plans/gpuix-heavy.sh bun run profile-layout-scale
//
// Ops, each WARM unmeasured then REPS measured; one op is a state change, its flush, and one `drawFrame()`:
//   a1 the header count label's text changes       a2 the counter label of one row in view changes
//   b  one keystroke into the focused header input (the test window draws that frame inside the key call, so it is all in "js")
//   c  the same string written again to a row label through Solid (`equals: false`; the host skips an equal text, so no batch is sent)
//   c2 the same string written again through the mutation queue (a batch is sent)
//   d  hover moves between two adjacent in-view rows (`style.hover`, no JS render; no `renderer.flush()`, which would make the tick whole)
//   e  nothing changed, `drawFrame()` only
// Instructions are the process's ri_instructions (native threads included): "js" is the state change and flush (applyBatch included),
// "frame" is `drawFrame()`. Counters are per op (the difference over the measured reps divided by REPS).
//
// Env:
//   COUNTS=1000,3000,10000   live rows of each run
//   OPS=a1,a2,b,c,c2,d,e     which ops run
//   REPS=60 WARM=10          measured and warm-up ops
//   JSON=1                   prints the results as JSON on the last line
//   LOOP=a1 LOOPS=n          one count (the first of COUNTS), one op run n times with no reads, to `sample <pid> 5` (HOLD_MS=ms waits first)
import { dlopen, ptr } from "bun:ffi"
import { For, createSignal, type Setter } from "solid-js"
import type { StyleDesc } from "@ghia/solid"
import { useGpuix } from "@ghia/solid"
import { createTestRoot } from "@ghia/solid/testing"

const COUNTS = (process.env.COUNTS ?? "1000,3000,10000").split(",").map(Number)
const OPS = (process.env.OPS ?? "a1,a2,b,c,c2,d,e").split(",")
const REPS = Number(process.env.REPS ?? "60")
const WARM = Number(process.env.WARM ?? "10")
const LOOP = process.env.LOOP
const LOOPS = Number(process.env.LOOPS ?? "1")
const HOLD_MS = Number(process.env.HOLD_MS ?? "0")
const WIDTH = 1280
const HEIGHT = 800
const HEADER_HEIGHT = 56
const ROW_HEIGHT = 48
const IN_VIEW_ROW = 5
const TICK_MS = 1000 / 120
const HOVER_ROWS = [10, 11]

const libSystem = dlopen("/usr/lib/libSystem.B.dylib", { proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" } })
const rusageBuffer = new BigUint64Array(296 / 8)
const rusageView = new DataView(rusageBuffer.buffer)
const rusageAddress = ptr(rusageBuffer)
/** offsetof(struct rusage_info_v4, ri_instructions) = 248 */
function readInstructions(): number {
  const status = libSystem.symbols.proc_pid_rusage(process.pid, 4, rusageAddress)
  if (status !== 0) throw new Error(`proc_pid_rusage failed: ${status}`)
  return Number(rusageView.getBigUint64(248, true))
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const low = sorted[middle - 1]
  const high = sorted[middle]
  if (high === undefined) throw new Error("median of no values")
  if (sorted.length % 2 === 0) {
    if (low === undefined) throw new Error("median of an odd-sized list")
    return (low + high) / 2
  }
  return high
}
function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const value = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
  if (value === undefined) throw new Error("percentile of no values")
  return value
}
const readOverhead = median(Array.from({ length: 200 }, () => -readInstructions() + readInstructions()))

type Page = {
  setHeader: () => void
  setCounter: (row: number) => void
  setCounterEqual: (row: number) => void
  writeTextThroughQueue: (id: number, text: string) => void
}

const rowStyle: StyleDesc = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  flexShrink: 0,
  height: ROW_HEIGHT,
  paddingLeft: 16,
  paddingRight: 16,
  backgroundColor: "#FFFFFF",
  borderBottom: "1px solid #E4E4E7",
  hover: { backgroundColor: "#F4F4F5" },
}

function Row(props: { index: number; counter: () => string }) {
  return (
    <div style={rowStyle}>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
        <text style={{ fontSize: 14, fontWeight: 600, color: "#18181B", whiteSpace: "nowrap" }}>{`Message title ${props.index}`}</text>
        <text style={{ fontSize: 12, color: "#71717A", whiteSpace: "nowrap" }}>{`Sender ${props.index % 97}, a preview of the body`}</text>
      </div>
      <text style={{ width: 72, fontSize: 12, color: "#2563EB", textAlign: "right" }}>{props.counter()}</text>
    </div>
  )
}

function App(props: { count: number; onReady: (page: Page) => void }) {
  const gpuix = useGpuix()
  if (!gpuix) throw new Error("no Ghia context")
  const [header, setHeader] = createSignal(`${props.count} items`)
  const counters = Array.from({ length: props.count }, (_, index) => createSignal(`r${index}:0`, { equals: false }))
  const indexes = Array.from({ length: props.count }, (_, index) => index)
  let headerTick = 0
  const counterTicks = new Map<number, number>()
  props.onReady({
    setHeader() {
      headerTick = (headerTick + 1) % 10
      setHeader(`${props.count} items, edit ${headerTick}`)
    },
    setCounter(row) {
      const tick = (counterTicks.get(row) ?? 0) + 1
      counterTicks.set(row, tick)
      const counter = counters[row]
      if (!counter) throw new Error(`no row ${row}`)
      counter[1](`r${row}:${tick}`)
    },
    setCounterEqual(row) {
      const counter = counters[row]
      if (!counter) throw new Error(`no row ${row}`)
      const setter: Setter<string> = counter[1]
      setter((current) => current)
    },
    writeTextThroughQueue(id, text) {
      gpuix.mutations.setText(id, text)
      gpuix.mutations.flushMutations()
    },
  })
  return (
    <div style={{ display: "flex", flexDirection: "column", width: WIDTH, height: HEIGHT, backgroundColor: "#FFFFFF" }}>
      <div style={{ display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0, height: HEADER_HEIGHT, padding: 12 }}>
        <input
          placeholder="Search"
          style={{ width: 396, height: 32, paddingLeft: 10, paddingRight: 10, fontSize: 13, color: "#18181B", backgroundColor: "#F4F4F5", border: "1px solid #E4E4E7", borderRadius: 8 }}
        />
        <text style={{ marginLeft: 16, fontSize: 12, color: "#71717A", whiteSpace: "nowrap" }}>{header()}</text>
      </div>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, overflow: "auto", height: HEIGHT - HEADER_HEIGHT }}>
        <For each={indexes}>{(index) => <Row index={index} counter={counters[index]![0]} />}</For>
      </div>
    </div>
  )
}

type Snapshot = Record<string, number>
type Reasons = Record<string, number>

function snapshot(renderer: ReturnType<typeof createTestRoot>["renderer"]): { numbers: Snapshot; unpatchable: Reasons; declines: Reasons } {
  const build = renderer.getBuildCounters()
  const retained = renderer.getRetainedCounters()
  const patch = renderer.getPatchCounters()
  const layout = renderer.getLayoutCounters()
  const frameWork = renderer.getFrameWorkCounters()
  return {
    numbers: {
      elementsBuilt: build.elementsBuilt,
      elementsSkipped: build.elementsSkipped,
      replays: retained.replays,
      retainedBuilds: retained.builds,
      retainedHits: retained.hits,
      lazyBuilds: retained.lazyBuilds,
      patchedFrames: patch.patchedFrames,
      relayoutPatches: patch.relayoutPatches,
      nodesLaidOut: layout.nodesLaidOut,
      nodesSized: layout.nodesSized,
      prepainted: frameWork.prepainted,
      painted: frameWork.painted,
      painted_frames: renderer.getPaintedFrameCount(),
    },
    unpatchable: JSON.parse(patch.unpatchable) as Reasons,
    declines: JSON.parse(patch.declines) as Reasons,
  }
}

type OpResult = {
  op: string
  count: number
  wallMeanMs: number
  wallP90Ms: number
  jsInstr: number
  frameInstr: number
  counters: Snapshot
  unpatchable: Reasons
  declines: Reasons
  batches: number
}

async function run(count: number): Promise<OpResult[]> {
  const testRoot = createTestRoot({ width: WIDTH, height: HEIGHT, appearance: "light" })
  const renderer = testRoot.renderer
  let page: Page | undefined
  const batchStats = { calls: 0 }
  const target = renderer as unknown as { applyBatch: (bytes: Uint8Array) => number[] }
  const applyBatch = target.applyBatch.bind(renderer)
  target.applyBatch = (bytes) => {
    batchStats.calls++
    return applyBatch(bytes)
  }
  const native = (renderer as unknown as { native: { simulateKeystrokes(keys: string): void } }).native
  renderer.setA11yActive(false)
  const mountStart = performance.now()
  testRoot.render(() => <App count={count} onReady={(ready) => (page = ready)} />)
  const mountMs = performance.now() - mountStart
  if (!page) throw new Error("the app did not hand over its page")
  const ready: Page = page
  renderer.clockPause()
  renderer.setInlineDraws(false)
  for (let i = 0; i < 5; i++) renderer.drawFrame()
  const input = renderer.findByType("input")[0]
  if (!input) throw new Error("no <input>")
  renderer.setWindowActive(true)
  renderer.focusElement(input.id)
  for (let i = 0; i < 3; i++) renderer.drawFrame()
  if (renderer.getFocusedElementId() !== input.id) throw new Error("the input is not focused")

  const counterText = renderer.findByText(`r${IN_VIEW_ROW}:0`)
  if (!counterText) throw new Error("no counter label of the in-view row")
  const counterId = counterText.id
  const counterString = counterText.text
  if (counterString === null) throw new Error("the counter label has no text")
  const hoverY = (row: number) => HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2
  console.error(`N=${count}: mounted in ${mountMs.toFixed(0)} ms, pid ${process.pid}`)

  let typed = false
  let hovered = 0
  const ops: Record<string, () => void> = {
    a1: () => testRoot.root.flushSync(() => ready.setHeader()),
    a2: () => testRoot.root.flushSync(() => ready.setCounter(IN_VIEW_ROW)),
    b: () => {
      // The helper `simulateKeystrokes` draws the frame itself in its closing `flushIfDirty`; this is the key as the platform delivers it.
      native.simulateKeystrokes(typed ? "Backspace" : "a")
      renderer.dispatchNativeEvents()
      typed = !typed
    },
    c: () => testRoot.root.flushSync(() => ready.setCounterEqual(IN_VIEW_ROW)),
    c2: () => {
      ready.writeTextThroughQueue(counterId, counterString)
    },
    d: () => {
      hovered = (hovered + 1) % HOVER_ROWS.length
      renderer.dispatchMouseMove(WIDTH / 2, hoverY(HOVER_ROWS[hovered]!))
    },
    e: () => {},
  }
  renderer.dispatchMouseMove(WIDTH / 2, hoverY(HOVER_ROWS[0]!))
  for (let i = 0; i < 5; i++) renderer.drawFrame()

  const step = (op: () => void) => {
    const a = readInstructions()
    op()
    // A display-link frame: time has moved since the last one, so a paint-only change can be a patched tick.
    renderer.clockAdvance(TICK_MS)
    const b = readInstructions()
    const t0 = performance.now()
    renderer.drawFrame()
    const t1 = performance.now()
    const c = readInstructions()
    return { js: b - a - readOverhead, frame: c - b - readOverhead, wall: t1 - t0 }
  }

  if (LOOP) {
    const op = ops[LOOP]
    if (!op) throw new Error(`unknown LOOP ${LOOP}`)
    for (let i = 0; i < WARM; i++) step(op)
    console.error(`looping ${LOOP} ${LOOPS} times, pid ${process.pid}, after ${HOLD_MS} ms`)
    if (HOLD_MS > 0) await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    for (let i = 0; i < LOOPS; i++) {
      op()
      renderer.clockAdvance(TICK_MS)
      renderer.drawFrame()
    }
    return []
  }

  const results: OpResult[] = []
  for (const name of OPS) {
    const op = ops[name]
    if (!op) throw new Error(`unknown op ${name}`)
    for (let i = 0; i < WARM; i++) step(op)
    const before = snapshot(renderer)
    const batchesBefore = batchStats.calls
    const samples = Array.from({ length: REPS }, () => step(op))
    const after = snapshot(renderer)
    const counters: Snapshot = {}
    for (const key of Object.keys(after.numbers)) counters[key] = (after.numbers[key]! - before.numbers[key]!) / REPS
    const reasonDelta = (afterReasons: Reasons, beforeReasons: Reasons): Reasons => {
      const delta: Reasons = {}
      for (const key of Object.keys(afterReasons)) {
        const change = afterReasons[key]! - (beforeReasons[key] ?? 0)
        if (change !== 0) delta[key] = change / REPS
      }
      return delta
    }
    const unpatchable = reasonDelta(after.unpatchable, before.unpatchable)
    const declines = reasonDelta(after.declines, before.declines)
    results.push({
      op: name,
      count,
      wallMeanMs: mean(samples.map((sample) => sample.wall)),
      wallP90Ms: percentile(samples.map((sample) => sample.wall), 0.9),
      jsInstr: median(samples.map((sample) => sample.js)),
      frameInstr: median(samples.map((sample) => sample.frame)),
      counters,
      unpatchable,
      declines,
      batches: (batchStats.calls - batchesBefore) / REPS,
    })
  }
  testRoot.unmount()
  return results
}

const M = (value: number) => (value / 1e6).toFixed(3)
const all: OpResult[] = []
for (const count of LOOP ? COUNTS.slice(0, 1) : COUNTS) all.push(...(await run(count)))
for (const result of all) {
  console.log(
    `N=${String(result.count).padEnd(5)} op=${result.op.padEnd(2)} wall mean ${result.wallMeanMs.toFixed(3)} p90 ${result.wallP90Ms.toFixed(3)} ms | ` +
      `instr js ${M(result.jsInstr)}M frame ${M(result.frameInstr)}M | batches ${result.batches} | ` +
      `built ${result.counters.elementsBuilt} skipped ${result.counters.elementsSkipped} | replays ${result.counters.replays} rbuilds ${result.counters.retainedBuilds} hits ${result.counters.retainedHits} lazy ${result.counters.lazyBuilds} | ` +
      `patched ${result.counters.patchedFrames} relayout ${result.counters.relayoutPatches} unpatchable ${JSON.stringify(result.unpatchable)} declines ${JSON.stringify(result.declines)} | ` +
      `laidOut ${result.counters.nodesLaidOut} sized ${result.counters.nodesSized} | prepainted ${result.counters.prepainted} painted ${result.counters.painted} | paintedFrames ${result.counters.painted_frames}`
  )
}
if (process.env.JSON === "1") console.log(JSON.stringify(all))
process.exit(0)
