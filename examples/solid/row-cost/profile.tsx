// Row-cost proxy: what a message row costs as plain GPUI elements against the same row as a Ghia (Solid) host tree, on the
// test renderer's window kind, in one process. The rows are the bench's: the Rust oracle (`RowOracle`, packages/native/src/oracle)
// copies `render_row` of ghia-bench's apps/gpui, and Rows.tsx copies the Row of apps/ghia. Both are a plain column of `count`
// rows in a window WIDTH x (count * 72), so every row is on screen and nothing is culled or virtualised.
//
// Run, from examples/ (its Vite config compiles the Solid files), with a release addon:
//   cd examples && GHIA_BENCH_MESSAGES=/path/to/ghia-bench/data/messages.json bun run profile-row-cost
// Instructions are the process's ri_instructions (native threads included), one read around each stage; medians over REPS.
//
// Env:
//   COUNTS=10,50,100   rows of each run
//   WIDTH=420          window and row width (the bench's list column is 420 wide, so snippets truncate as they do there)
//   SHOT=dir           saves a PNG of the oracle's and of the Ghia column's window of each count, to compare the pictures
//   REPS=15            measured frames or crossings of each number (after SETTLE=8 unmeasured ones)
//   MODES=oracle,options,ghia   which parts run; `decor` adds the raw rows with what Ghia puts on its divs (hitbox, ids, bounds closures)
//                      one at a time, `direct` the rows as one element each with no Div per node (packages/native/src/oracle/direct.rs)
//   HITS=1             prints the hit chain over the avatar of row 2 for the Ghia-like div row and for the direct row (with `decor`, `direct`)
//   A11Y=0             takes the pretend screen reader away from the Ghia window (default 0 here: a bench run has none)
//   JSON=1             prints the results as JSON on the last line
//   HOLD_MS=0          LOOP only: waits after the setup, before the loop (time to attach `sample`)
//   LOOP=name LOOPS=n  runs one loop of `oracle-whole`, `oracle-cross` (CONFIG=name picks the oracle config of a `decor` or `direct` mode), or `ghia-{column|list}-{on|off}-{whole|cross}` (on: retention
//                      on, "whole" then rebuilds everything and records it) LOOPS times in a row, without reading the counter (RAW, for `sample`)
import { dlopen, ptr } from "bun:ffi"
import { existsSync, readFileSync } from "node:fs"
import { RowOracle } from "../../../packages/native/index.js"
import { createTestRoot } from "@ghia/solid/testing"
import type { Message } from "../mailbox-scroll-hover/types"
import { Rows } from "./Rows"

const MESSAGES_PATH = process.env.GHIA_BENCH_MESSAGES
if (!MESSAGES_PATH) throw new Error("GHIA_BENCH_MESSAGES must be the path of ghia-bench's data/messages.json")
if (!existsSync(MESSAGES_PATH)) throw new Error(`GHIA_BENCH_MESSAGES is ${MESSAGES_PATH}, which does not exist`)
const COUNTS = (process.env.COUNTS ?? "10,50,100").split(",").map(Number)
const REPS = Number(process.env.REPS ?? "15")
const SETTLE = Number(process.env.SETTLE ?? "8")
const MODES = (process.env.MODES ?? "oracle,options,ghia").split(",")
const A11Y = process.env.A11Y === "1"
const SHOT = process.env.SHOT
const HITS = process.env.HITS === "1"
const CONFIG = process.env.CONFIG
const LOOP = process.env.LOOP
const LOOPS = Number(process.env.LOOPS ?? "1")
const HOLD_MS = Number(process.env.HOLD_MS ?? "0")
const ROW_HEIGHT = 72
const WIDTH = Number(process.env.WIDTH ?? "420")
const HOVER_X = WIDTH / 2
const TICK_MS = 1000 / 120

// <sys/resource.h>: offsetof(struct rusage_info_v4, ri_instructions) = 248, sizeof = 296.
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
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const readOverhead = median(Array.from({ length: 200 }, () => -readInstructions() + readInstructions()))
const M = (value: number) => (value / 1e6).toFixed(3)

const all = JSON.parse(readFileSync(MESSAGES_PATH, "utf8")) as Message[]
const rowsOf = (count: number) => all.slice(0, count)
const rowCenter = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2

interface Series {
  /** median instructions of a measured stage, per rep */
  whole?: number
  crossInput?: number
  crossDraw?: number
  cross?: number
  sameRow?: number
  /** counters, per measured unit (one whole frame or one crossing) */
  extra: Record<string, number>
}
const results: Record<string, Record<string, Series>> = {}
const record = (config: string, count: number, patch: Partial<Series>) => {
  const byCount = (results[config] ??= {})
  const series = (byCount[String(count)] ??= { extra: {} })
  Object.assign(series, patch, { extra: { ...series.extra, ...patch.extra } })
}

/** `stage` returns the instructions of the part it measures (it reads the counter itself). */
function measure(stage: () => number, reps = REPS): number {
  for (let i = 0; i < SETTLE; i++) stage()
  return median(Array.from({ length: reps }, stage))
}
const timed = (run: () => void) => () => {
  const a = readInstructions()
  run()
  return readInstructions() - a - readOverhead
}

// ── a. the oracle ───────────────────────────────────────────────────────────────

interface OracleConfig {
  name: string
  domHitTesting: boolean
  maxDrawPasses: number
  a11yActive: boolean
  windowActive: boolean
  /** [hitbox, bounds, ids, stackingRoot] put on each div of the raw row (and its root column) */
  decorations?: [boolean, boolean, boolean, boolean]
  /** the row is one element: [hitbox per node, bounds write per node, style resolved every frame] */
  direct?: [boolean, boolean, boolean]
}
const GPUI_DEFAULTS: OracleConfig = { name: "gpui", domHitTesting: false, maxDrawPasses: 1, a11yActive: false, windowActive: false }
const OPTION_CONFIGS: OracleConfig[] = [
  GPUI_DEFAULTS,
  { ...GPUI_DEFAULTS, name: "gpui+domHit", domHitTesting: true },
  { ...GPUI_DEFAULTS, name: "gpui+passes4", maxDrawPasses: 4 },
  { ...GPUI_DEFAULTS, name: "gpui+active", windowActive: true },
  { ...GPUI_DEFAULTS, name: "gpui+a11y", a11yActive: true },
  { name: "gpui+ghiaSet", domHitTesting: true, maxDrawPasses: 4, a11yActive: false, windowActive: true },
]

const GHIA_SET: OracleConfig = { name: "gpui+ghiaSet", domHitTesting: true, maxDrawPasses: 4, a11yActive: false, windowActive: true }
/** What Ghia puts on each host div, one part at a time, on the raw divs (the DOM hit testing Ghia runs under is on in all of them). */
const DECOR_CONFIGS: OracleConfig[] = [
  GHIA_SET,
  { ...GHIA_SET, name: "div+hitbox", decorations: [true, false, false, false] },
  { ...GHIA_SET, name: "div+ids", decorations: [false, false, true, false] },
  { ...GHIA_SET, name: "div+bounds", decorations: [false, true, false, false] },
  { ...GHIA_SET, name: "div+ids+bounds", decorations: [false, true, true, false] },
  { ...GHIA_SET, name: "div+hitbox+ids+bounds", decorations: [true, true, true, false] },
  { ...GHIA_SET, name: "div+stackingRoot", decorations: [false, false, false, true] },
  { ...GHIA_SET, name: "div+all+stackingRoot", decorations: [true, true, true, true] },
]
/** The same row as one element: layout, hitboxes and paint of every node done by it. */
const DIRECT_CONFIGS: OracleConfig[] = [
  { ...GHIA_SET, name: "direct", direct: [true, false, false] },
  { ...GHIA_SET, name: "direct-noHitbox", direct: [false, false, false] },
  { ...GHIA_SET, name: "direct+bounds", direct: [true, true, false] },
  { ...GHIA_SET, name: "direct+styleEachFrame", direct: [true, false, true] },
  { ...GHIA_SET, name: "direct+bounds+style", direct: [true, true, true] },
]
const ALL_CONFIGS = [...OPTION_CONFIGS, ...DECOR_CONFIGS, ...DIRECT_CONFIGS]

function openOracle(count: number, config: OracleConfig) {
  const oracle = new RowOracle({
    width: WIDTH,
    height: count * ROW_HEIGHT,
    domHitTesting: config.domHitTesting,
    maxDrawPasses: config.maxDrawPasses,
    a11yActive: config.a11yActive,
    windowActive: config.windowActive,
  })
  oracle.setInlineDraws(false)
  oracle.setRows(JSON.stringify(rowsOf(count)), 0)
  if (config.decorations) oracle.setDecorations(...config.decorations)
  if (config.direct) {
    oracle.setRowKind("direct")
    oracle.setDirectKnobs(...config.direct)
  }
  for (let i = 0; i < SETTLE; i++) oracle.drawWholeFrame()
  return oracle
}

/** Alternates the pointer between row 2 and row 3 (both unselected): a move that crosses one row boundary, then its frame. */
function crossingSteps(move: (x: number, y: number) => void, draw: () => void) {
  let row = 2
  move(HOVER_X, rowCenter(row))
  draw()
  const input = (): number => {
    row = row === 2 ? 3 : 2
    const a = readInstructions()
    move(HOVER_X, rowCenter(row))
    return readInstructions() - a - readOverhead
  }
  const frame = timed(draw)
  return { input, frame }
}

function runOracle(count: number, config: OracleConfig, rowsAlso: boolean) {
  const oracle = openOracle(count, config)
  const before = oracle.getCounters()
  const whole = measure(timed(() => oracle.drawWholeFrame()))
  const after = oracle.getCounters()
  const frames = after[0]! - before[0]!
  const cross = crossingSteps((x, y) => oracle.simulateMouseMove(x, y), () => oracle.drawFrame())
  const renders0 = oracle.getCounters()[0]!
  const inputs: number[] = []
  const draws: number[] = []
  for (let i = 0; i < SETTLE + REPS; i++) {
    const input = cross.input()
    const draw = cross.frame()
    if (i >= SETTLE) {
      inputs.push(input)
      draws.push(draw)
    }
  }
  const renders = oracle.getCounters()[0]! - renders0
  const sameRow = measure(() => {
    // Inside row 2: no hover change.
    const a = readInstructions()
    oracle.simulateMouseMove(HOVER_X + 5, rowCenter(2))
    oracle.drawFrame()
    return readInstructions() - a - readOverhead
  })
  if (SHOT && config === GPUI_DEFAULTS) oracle.captureScreenshot(`${SHOT}/oracle-${count}.png`)
  if (SHOT && (config.decorations || config.direct)) oracle.captureScreenshot(`${SHOT}/${config.name}-${count}.png`)
  if (HITS && (config.direct || config.name === "div+hitbox+ids+bounds")) {
    oracle.simulateMouseMove(34, rowCenter(2) - 36 + 12 + 18)
    oracle.drawFrame()
    console.log(`hit chain over the avatar of row 2, ${config.name}: ${JSON.stringify(oracle.getHitChain())}`)
  }
  oracle.dispose()
  record(config.name, count, {
    whole,
    crossInput: median(inputs),
    crossDraw: median(draws),
    cross: median(inputs.map((v, i) => v + draws[i]!)),
    sameRow,
    extra: {
      rendersPerWhole: frames / (SETTLE + REPS),
      divsPerWhole: (after[1]! - before[1]!) / frames,
      textsPerWhole: (after[2]! - before[2]!) / frames,
      rendersPerCrossing: renders / (SETTLE + REPS),
    },
  })
  void rowsAlso
}

if (MODES.includes("oracle") && !LOOP) {
  for (const count of COUNTS) runOracle(count, GPUI_DEFAULTS, true)
  for (const count of COUNTS) runOracle(count, OPTION_CONFIGS.at(-1)!, false)
}
if (MODES.includes("decor") && !LOOP) for (const config of DECOR_CONFIGS) for (const count of COUNTS) runOracle(count, config, false)
if (MODES.includes("direct") && !LOOP) for (const config of DIRECT_CONFIGS) for (const count of COUNTS) runOracle(count, config, false)
if (MODES.includes("options") && !LOOP) {
  for (const config of OPTION_CONFIGS) for (const count of COUNTS) if (!(config === GPUI_DEFAULTS && MODES.includes("oracle"))) runOracle(count, config, false)
}

// ── b, c. the same rows as a Solid app ──────────────────────────────────────────

interface BuildNumbers {
  elementsBuilt: number
  elementsSkipped: number
  styleDescClones: number
  styleAppliesComputed: number
  styleAppliesReplayed: number
  painted: number
}

function runGhia(count: number, container: "column" | "list") {
  const root = createTestRoot({ width: WIDTH, height: count * ROW_HEIGHT, appearance: "light" })
  const renderer = root.renderer
  if (!A11Y) renderer.setA11yActive(false)
  root.render(() => <Rows messages={rowsOf(count)} selected={0} container={container} />)
  renderer.clockPause()
  renderer.setInlineDraws(false)
  const frameStep = () => {
    renderer.clockAdvance(TICK_MS)
    renderer.dispatchNativeEvents()
    renderer.drawFrame()
  }
  for (let i = 0; i < 5; i++) frameStep()
  renderer.clockAdvance(3000)
  renderer.dispatchNativeEvents()
  for (let i = 0; i < 5; i++) frameStep()
  for (let quiet = 0, i = 0; quiet < 30; i++) {
    if (i > 600) throw new Error("the window still paints after 600 ticks of settling")
    const painted = renderer.getPaintedFrameCount()
    frameStep()
    quiet = renderer.getPaintedFrameCount() === painted ? quiet + 1 : 0
  }
  const counters = (): BuildNumbers => {
    const build = renderer.getBuildCounters()
    return {
      elementsBuilt: build.elementsBuilt,
      elementsSkipped: build.elementsSkipped,
      styleDescClones: build.styleDescClones,
      styleAppliesComputed: build.styleAppliesComputed,
      styleAppliesReplayed: build.styleAppliesReplayed,
      painted: renderer.getPaintedFrameCount(),
    }
  }
  const perUnit = (before: BuildNumbers, after: BuildNumbers, units: number, prefix: string) => ({
    [`${prefix}ElementsBuilt`]: (after.elementsBuilt - before.elementsBuilt) / units,
    [`${prefix}ElementsSkipped`]: (after.elementsSkipped - before.elementsSkipped) / units,
    [`${prefix}StyleDescClones`]: (after.styleDescClones - before.styleDescClones) / units,
    [`${prefix}StyleApplies`]: (after.styleAppliesComputed - before.styleAppliesComputed) / units,
    [`${prefix}StyleReplays`]: (after.styleAppliesReplayed - before.styleAppliesReplayed) / units,
    [`${prefix}FramesPainted`]: (after.painted - before.painted) / units,
  })
  const units = SETTLE + REPS

  // A whole frame: a mutation-free invalidation (what `flush` does) then the display link's draw.
  const wholeFrame = () => {
    renderer.flush()
    renderer.drawFrame()
  }
  const crossing = () => {
    let row = 2
    renderer.dispatchMouseMove(HOVER_X, rowCenter(row))
    frameStep()
    return () => {
      row = row === 2 ? 3 : 2
      const a = readInstructions()
      renderer.dispatchMouseMove(HOVER_X, rowCenter(row))
      const b = readInstructions()
      renderer.clockAdvance(TICK_MS)
      renderer.dispatchNativeEvents()
      const c = readInstructions()
      renderer.drawFrame()
      const d = readInstructions()
      return [b - a - readOverhead, c - b - readOverhead, d - c - readOverhead] as const
    }
  }
  const crossingRun = (config: string) => {
    const step = crossing()
    for (let i = 0; i < SETTLE; i++) step()
    const before = counters()
    const samples = Array.from({ length: REPS }, step)
    const after = counters()
    // A move inside row 2: the pointer changes, no row does.
    renderer.dispatchMouseMove(HOVER_X, rowCenter(2))
    frameStep()
    let dx = 0
    const sameRow = measure(() => {
      dx = dx === 0 ? 3 : 0
      const a = readInstructions()
      renderer.dispatchMouseMove(HOVER_X + dx, rowCenter(2))
      renderer.clockAdvance(TICK_MS)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      return readInstructions() - a - readOverhead
    })
    record(config, count, {
      crossInput: median(samples.map((s) => s[0])),
      crossDraw: median(samples.map((s) => s[2])),
      cross: median(samples.map((s) => s[0] + s[1] + s[2])),
      sameRow,
      extra: perUnit(before, after, REPS, "crossing"),
    })
  }

  // b. retention off: every element is built.
  renderer.setRetainEnabled(false)
  for (let i = 0; i < SETTLE; i++) wholeFrame()
  {
    const before = counters()
    const whole = measure(timed(wholeFrame))
    const after = counters()
    record(`ghia-${container}-retain-off`, count, { whole, extra: perUnit(before, after, units, "whole") })
  }
  crossingRun(`ghia-${container}-retain-off`)

  // c. normal: retention on. "whole" is the frame that builds everything and records it (retention just turned on); "replay" is the
  // same invalidation once the records exist.
  const wholeOn = () => {
    renderer.setRetainEnabled(false)
    renderer.setRetainEnabled(true)
    const a = readInstructions()
    wholeFrame()
    return readInstructions() - a - readOverhead
  }
  renderer.setRetainEnabled(true)
  for (let i = 0; i < SETTLE; i++) wholeFrame()
  {
    const before = counters()
    const whole = measure(wholeOn)
    const after = counters()
    record(`ghia-${container}-retain-on`, count, { whole, extra: perUnit(before, after, units, "whole") })
  }
  for (let i = 0; i < SETTLE; i++) wholeFrame()
  {
    const before = counters()
    const replay = measure(timed(wholeFrame))
    const after = counters()
    record(`ghia-${container}-retain-on`, count, { extra: { replay, ...perUnit(before, after, units, "replay") } })
  }
  crossingRun(`ghia-${container}-retain-on`)
  const patch = renderer.getPatchCounters() as unknown as Record<string, number>
  record(`ghia-${container}-retain-on`, count, { extra: { patchedFrames: patch.patchedFrames ?? 0, inPlacePrimitives: patch.inPlacePrimitives ?? 0 } })
  if (SHOT && container === "column") renderer.captureScreenshot(`${SHOT}/ghia-${count}.png`)
  root.unmount()
}

if (MODES.includes("ghia") && !LOOP) for (const container of ["column", "list"] as const) for (const count of COUNTS) runGhia(count, container)

// ── single loops for `sample` ──────────────────────────────────────────────────

if (LOOP) {
  const count = COUNTS[0]!
  console.error(`loop ${LOOP} count ${count} pid ${process.pid}`)
  const hold = async () => {
    console.error("setup done")
    if (HOLD_MS) await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
  }
  if (LOOP.startsWith("oracle")) {
    const config = CONFIG ? ALL_CONFIGS.find((candidate) => candidate.name === CONFIG) : GPUI_DEFAULTS
    if (!config) throw new Error(`CONFIG ${CONFIG} is none of ${ALL_CONFIGS.map((candidate) => candidate.name).join(", ")}`)
    const oracle = openOracle(count, config)
    const cross = crossingSteps((x, y) => oracle.simulateMouseMove(x, y), () => oracle.drawFrame())
    await hold()
    const start = readInstructions()
    for (let i = 0; i < LOOPS; i++) {
      if (LOOP === "oracle-whole") oracle.drawWholeFrame()
      else {
        cross.input()
        oracle.drawFrame()
      }
    }
    console.log(`${LOOP}: ${((readInstructions() - start) / LOOPS / 1e6).toFixed(3)}M instr per loop`)
    oracle.dispose()
  } else {
    const root = createTestRoot({ width: WIDTH, height: count * ROW_HEIGHT, appearance: "light" })
    const renderer = root.renderer
    if (!A11Y) renderer.setA11yActive(false)
    root.render(() => <Rows messages={rowsOf(count)} selected={0} container={LOOP.includes("list") ? "list" : "column"} />)
    renderer.clockPause()
    renderer.setInlineDraws(false)
    const frameStep = () => {
      renderer.clockAdvance(TICK_MS)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
    }
    for (let i = 0; i < 10; i++) frameStep()
    renderer.clockAdvance(3000)
    renderer.dispatchNativeEvents()
    for (let i = 0; i < 10; i++) frameStep()
    renderer.setRetainEnabled(LOOP.includes("-on-"))
    for (let i = 0; i < 5; i++) {
      renderer.flush()
      renderer.drawFrame()
    }
    let row = 2
    renderer.dispatchMouseMove(HOVER_X, rowCenter(row))
    frameStep()
    await hold()
    const start = readInstructions()
    for (let i = 0; i < LOOPS; i++) {
      if (LOOP.endsWith("-whole")) {
        if (LOOP.includes("-on-")) {
          renderer.setRetainEnabled(false)
          renderer.setRetainEnabled(true)
        }
        renderer.flush()
        renderer.drawFrame()
      } else {
        row = row === 2 ? 3 : 2
        renderer.dispatchMouseMove(HOVER_X, rowCenter(row))
        frameStep()
      }
    }
    console.log(`${LOOP}: ${((readInstructions() - start) / LOOPS / 1e6).toFixed(3)}M instr per loop`)
    root.unmount()
  }
  process.exit(0)
}

// ── report ─────────────────────────────────────────────────────────────────────

console.log(`rows of ${WIDTH} x ${ROW_HEIGHT}, window ${WIDTH} x (count * 72), REPS ${REPS} after ${SETTLE} unmeasured, rusage read overhead ${readOverhead} instr`)
const slope = (values: [number, number][]) => {
  // least squares through the points
  const n = values.length
  const sx = values.reduce((a, [x]) => a + x, 0)
  const sy = values.reduce((a, [, y]) => a + y, 0)
  const sxx = values.reduce((a, [x]) => a + x * x, 0)
  const sxy = values.reduce((a, [x, y]) => a + x * y, 0)
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  return { perRow: b, base: (sy - b * sx) / n }
}
for (const [config, byCount] of Object.entries(results)) {
  const counts = Object.keys(byCount).map(Number).sort((a, b) => a - b)
  console.log(`\n[${config}]`)
  for (const count of counts) {
    const s = byCount[count]!
    const parts = [
      s.whole !== undefined ? `whole ${M(s.whole)}M (${(s.whole / count / 1e3).toFixed(1)}k/row)` : "",
      s.cross !== undefined ? `crossing ${M(s.cross)}M (input ${M(s.crossInput!)}M, draw ${M(s.crossDraw!)}M)` : "",
      s.sameRow !== undefined ? `same-row move ${M(s.sameRow)}M` : "",
    ].filter(Boolean)
    const extras = Object.entries(s.extra).map(([key, value]) => `${key}=${Number.isInteger(value) ? value : value.toFixed(2)}`)
    console.log(`  ${String(count).padStart(4)} rows: ${parts.join("  ")}  ${extras.join(" ")}`)
  }
  if (counts.length >= 2) {
    const line = (label: string, pick: (s: Series) => number | undefined) => {
      const points = counts.filter((c) => pick(byCount[c]!) !== undefined).map((c) => [c, pick(byCount[c]!)!] as [number, number])
      if (points.length < 2) return ""
      const fit = slope(points)
      return `${label} ${(fit.perRow / 1e3).toFixed(1)}k per row (base ${M(fit.base)}M)`
    }
    console.log(`  slope over count: ${[line("whole", (s) => s.whole), line("crossing", (s) => s.cross), line("crossing draw", (s) => s.crossDraw)].filter(Boolean).join("; ")}`)
  }
}
if (process.env.JSON === "1") console.log(JSON.stringify(results))
process.exit(0)
