// Stylesheet cost: N items styled by the inline `style` prop against the same look from a stylesheet class rule, on the test
// renderer's window kind, in one process. Items are ~52 x 24 boxes in a wrapping flex container, so every one is laid out,
// built and painted. The sheet's rules say the same eight declarations the inline objects do.
//
// Run, from examples/ (its Vite config compiles the Solid files), with a release addon and ONE mode per process, so a mode starts
// in a fresh process (JIT and allocator state are not shared):
//   cd examples && for m in inline sheet inline+sheet; do MODES=$m COUNTS=1000,5000 REPS=15 bun --bun run profile-stylesheet-cost; done
// (`ghia dev` needs Bun as the runtime, hence `bun --bun`; the new modes: `MODES=runtime COUNTS=5000,10000`, `MODES=atomic`, `MODES=atomic-inline`)
// Instructions are the process's ri_instructions (native threads included), one read around each stage, as row-cost does.
//
// Env:
//   COUNTS=1000,5000   items of each run
//   REPS=15            measured repetitions of each phase (after SETTLE=3 unmeasured ones); mount repeats MOUNT_REPS=7 times
//   MODES=inline,sheet,inline+sheet   what runs, in this order, in this process. `attrs` and `attrs-canvas` are the inline look
//          with a class and two data-* attributes on each item, a div and a canvas, and no sheet: what an app without a sheet pays
//   JSON=1             prints the results as JSON on the last line; "spread" columns are (max - min) / median of the repetitions
//   PHASES=a,b         only these phases run (and are reported); MARK=1 prints "[phase] name" to stderr as each starts, so
//          a sampling profiler can be attached to the right one (REPS large keeps a phase running long enough)
//   ATOMIC_RECIPES=0   `atomic` modes: 0 gives every item its own random classes; n > 0 repeats n distinct class sets over the items,
//          as a design system's components do (elements with equal matches share one cascade)
//   EXTRA_RULES=0      `runtime` mode: unrelated atomic rules added to the runtime sheet (the sheet's size)
//   More modes: `runtime`, `atomic`, `atomic-inline`, below.
//
// Phases. Each is reported twice: "batch" is only the mutation and its batch apply (Solid's update, the mutation queue's flush,
// native applyBatch with flush_styles), and "end-to-end" adds the view's flush and the frame that
// paints it, which runs after the batch window closes:
//   mount  N items added to a root that already has its `<style>` element (mounted and drawn in an earlier, unmeasured batch, as an
//          app loads its sheet once and mounts rows later) and the first frame that draws them
//   sheet-load  the `<style>` element added to a root that already shows N items (sheet modes only): a sheet add matches every
//          element by design; the off half of each pair, which winds the sheets down, is unmeasured
//   class  one item's class gains / loses `active` (inline: its style object is swapped)
//   data   one item's data-active attribute is set / removed (inline: its style object is swapped)
//   many   all N items at once, on and off (class on all / style on all)
//
// Runtime sheet changes (mode `runtime`): N items mounted with an adopted CSSStyleSheet (`.item` rules, plus EXTRA_RULES unrelated
// atomic ones) that styles them, then CSSOM edits of that sheet, each phase an add and a remove reported separately:
//   insert-nomatch / delete-nomatch  insertRule(`.nomatch-x { color: red }`) at the end / deleteRule of it
//   insert-one / delete-one          the same for a rule that matches one element (`#i<middle>`)
//   insert-all / delete-all          the same for a rule that matches every item (`.item`)
//   edit-all / edit-one              deleteRule + insertRule at the same index in one flush, new declaration value (the CSSOM here has
//                                    no `rule.style`, so this is how a declaration is edited); alternates between two values
//   replace-same                     replaceSync with the sheet's own text: nothing changes, so this is the pure reload cost
//   style-add / style-remove / style-text  a second `<style>` element with one unrelated rule: added, removed, its text edited
//
// StyleX-like (modes `atomic` and `atomic-inline`): a static sheet of ATOMIC_RULES (3000) one-declaration classes (`.x1a2b3c4 { width: 42px }`)
// and N items of 10-20 of them each (distinct properties, deterministic), against the same declarations as inline styles:
//   mount, sheet-load (atomic only), swap-one (one item's background-color class swapped), swap-all (every item's)
// The items are 60 x 48 boxes by estimate and the window stops at 16000 px (a Metal texture limit), so at 5000 items the last rows lie
// below the window; both modes lay out and build them alike.
// `matched` and `cascades` (counted over the whole phase) are the build counters elementsRematched and cascadesComputed of one repetition (sheet modes).
import { dlopen, ptr } from "bun:ffi"
import { For, createSelector, createSignal } from "solid-js"
import type { StyleDesc } from "@ghia/solid"
import { CSSStyleSheet, document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot } from "@ghia/solid/testing"

const COUNTS = (process.env.COUNTS ?? "1000,5000").split(",").map(Number)
const REPS = Number(process.env.REPS ?? "15")
const SETTLE = Number(process.env.SETTLE ?? "3")
const MOUNT_REPS = Number(process.env.MOUNT_REPS ?? "7")
const MODES = (process.env.MODES ?? "inline,sheet,inline+sheet").split(",")
const WIDTH = 1200
const ROW_HEIGHT = 24
const ITEM_WIDTH = 52
const TICK_MS = 1000 / 120
const PHASES = process.env.PHASES?.split(",")
const MARK = process.env.MARK === "1"
const EXTRA_RULES = Number(process.env.EXTRA_RULES ?? "0")
const ATOMIC_RULES = 3000
const ATOMIC_RECIPES = Number(process.env.ATOMIC_RECIPES ?? "0")
const want = (phase: string) => {
  const wanted = PHASES === undefined || PHASES.includes(phase)
  if (wanted && MARK) console.error(`[phase] ${phase} pid ${process.pid}`)
  return wanted
}

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

const BASE: StyleDesc = {
  display: "flex",
  padding: "10px 24px",
  margin: 2,
  height: 20,
  backgroundColor: "#3b82f6",
  color: "#ffffff",
  borderRadius: 6,
  fontSize: 13,
}
const ACTIVE: StyleDesc = {
  display: "flex",
  padding: "10px 28px",
  margin: 2,
  height: 20,
  backgroundColor: "#ef4444",
  color: "#111111",
  borderRadius: 10,
  fontSize: 15,
}
const ACTIVE_BACKGROUND = "rgb(239, 68, 68)"

const SHEET = `
  .item { display: flex; padding: 10px 24px; margin: 2px; height: 20px; background-color: #3b82f6; color: #ffffff; border-radius: 6px; font-size: 13px }
  .item.active, .item[data-active] { display: flex; padding: 10px 28px; margin: 2px; height: 20px; background-color: #ef4444; color: #111111; border-radius: 10px; font-size: 15px }
`
const UNRELATED_SHEET = Array.from(
  { length: 20 },
  (_, index) => `.unused-${index} { display: flex; padding: ${index}px 8px; background-color: #10b981; color: #fff; border-radius: ${index}px }`
).join("\n")

interface AtomicClass {
  name: string
  property: string
  camel: string
  /** the declaration's value as the sheet says it */
  text: string
  /** the same value as the inline style says it */
  inline: string | number
}

function mulberry32(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const camelCase = (property: string) => property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

/** [property, values]: a number is a unitless value, a string is written as it is */
function atomicSpecs(): Array<[string, Array<string | number>]> {
  const lengths = (from: number, to: number, step = 1) => {
    const values: string[] = []
    for (let value = from; value <= to; value += step) values.push(`${value}px`)
    return values
  }
  return [
    ["display", ["flex", "block", "inline-flex"]],
    ["flex-grow", [0, 1, 2, 3]],
    ["flex-shrink", [0, 1, 2]],
    ["flex-basis", lengths(0, 40, 2)],
    ["flex-direction", ["row", "column"]],
    ["font-size", lengths(10, 20)],
    ["font-weight", [100, 200, 300, 400, 500, 600, 700, 800, 900]],
    ["line-height", lengths(12, 28)],
    ["border-radius", lengths(0, 12)],
    ["width", lengths(20, 80)],
    ["height", lengths(10, 40)],
    ["gap", lengths(0, 8)],
    ["padding-top", lengths(0, 12)],
    ["padding-right", lengths(0, 12)],
    ["padding-bottom", lengths(0, 12)],
    ["padding-left", lengths(0, 12)],
    ["margin-top", lengths(0, 8)],
    ["margin-right", lengths(0, 8)],
    ["margin-bottom", lengths(0, 8)],
    ["margin-left", lengths(0, 8)],
    ["opacity", [0.5, 0.6, 0.7, 0.8, 0.9, 1]],
    ["justify-content", ["flex-start", "center", "flex-end", "space-between", "space-around"]],
    ["align-items", ["flex-start", "center", "flex-end", "stretch"]],
    ["flex-wrap", ["nowrap", "wrap"]],
    ["min-width", lengths(0, 30)],
  ]
}

/** `total` one-declaration classes with deterministic names and values; the rest of the total is colors */
function buildAtomic(total: number): { classes: AtomicClass[]; byProperty: Map<string, AtomicClass[]> } {
  const random = mulberry32(0x5eed)
  const names = new Set<string>()
  const newName = () => {
    for (;;) {
      const name = `x${Math.floor(random() * 36 ** 7).toString(36).padStart(7, "0")}`
      if (!names.has(name)) {
        names.add(name)
        return name
      }
    }
  }
  const classes: AtomicClass[] = []
  const add = (property: string, value: string | number) =>
    classes.push({ name: newName(), property, camel: camelCase(property), text: String(value), inline: value })
  for (const spec of atomicSpecs()) for (const value of spec[1]) add(spec[0], value)
  const colorEach = Math.floor((total - classes.length) / 2)
  for (const property of ["color", "background-color"]) {
    const seen = new Set<string>()
    while (seen.size < colorEach) {
      const hex = `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, "0")}`
      if (seen.has(hex)) continue
      seen.add(hex)
      add(property, hex)
    }
  }
  while (classes.length < total) add("color", `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, "0")}`)
  const byProperty = new Map<string, AtomicClass[]>()
  for (const atomic of classes) {
    const list = byProperty.get(atomic.property) ?? []
    list.push(atomic)
    byProperty.set(atomic.property, list)
  }
  return { classes, byProperty }
}

const atomic = buildAtomic(ATOMIC_RULES)
const atomicSheet = (rules: AtomicClass[]) => rules.map((rule) => `.${rule.name} { ${rule.property}: ${rule.text} }`).join("\n")
const ATOMIC_SHEET = atomicSheet(atomic.classes)
const RUNTIME_SHEET = [SHEET, atomicSheet(atomic.classes.slice(0, EXTRA_RULES))].join("\n")

interface AtomicItem {
  classesA: string
  classesB: string
  styleA: StyleDesc
  styleB: StyleDesc
  /** background-color of A and of B, as the sheet says it */
  backgroundA: string
  backgroundB: string
}

const rgbOf = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`

/** Per item, 10-20 classes of distinct properties, background-color always one of them: variant B swaps only that class */
function buildAtomicItems(count: number): AtomicItem[] {
  const distinct = ATOMIC_RECIPES > 0 ? Math.min(ATOMIC_RECIPES, count) : count
  const recipes = buildDistinctAtomicItems(distinct)
  return Array.from({ length: count }, (_, index) => recipes[index % distinct] as AtomicItem)
}

function buildDistinctAtomicItems(count: number): AtomicItem[] {
  const random = mulberry32(0xa70c)
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)] as T
  const otherProperties = [...atomic.byProperty.keys()].filter((property) => property !== "background-color")
  const backgrounds = atomic.byProperty.get("background-color") as AtomicClass[]
  return Array.from({ length: count }, () => {
    const shuffled = [...otherProperties]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const swap = shuffled[i] as string
      shuffled[i] = shuffled[j] as string
      shuffled[j] = swap
    }
    const others = shuffled.slice(0, 9 + Math.floor(random() * 11)).map((property) => pick(atomic.byProperty.get(property) as AtomicClass[]))
    const backgroundA = pick(backgrounds)
    let backgroundB = pick(backgrounds)
    while (backgroundB === backgroundA) backgroundB = pick(backgrounds)
    const styleOf = (chosen: AtomicClass[]): StyleDesc => {
      const style: Record<string, string | number> = {}
      for (const declaration of chosen) style[declaration.camel] = declaration.inline
      return style as StyleDesc
    }
    const withBackground = (background: AtomicClass) => [...others, background]
    return {
      classesA: withBackground(backgroundA).map((declaration) => declaration.name).join(" "),
      classesB: withBackground(backgroundB).map((declaration) => declaration.name).join(" "),
      styleA: styleOf(withBackground(backgroundA)),
      styleB: styleOf(withBackground(backgroundB)),
      backgroundA: backgroundA.text,
      backgroundB: backgroundB.text,
    }
  })
}

interface Control {
  setShowItems(on: boolean): void
  setShowStyle(on: boolean): void
  setClassIndex(index: number): void
  setDataIndex(index: number): void
  setAll(on: boolean): void
  setShowSecond(on: boolean): void
  setSecondText(text: string): void
  items: unknown[]
}

const newControl = (): Control => ({
  setShowItems: () => { throw new Error("not rendered") },
  setShowStyle: () => { throw new Error("not rendered") },
  setClassIndex: () => { throw new Error("not rendered") },
  setDataIndex: () => { throw new Error("not rendered") },
  setAll: () => { throw new Error("not rendered") },
  setShowSecond: () => { throw new Error("not rendered") },
  setSecondText: () => { throw new Error("not rendered") },
  items: [],
})

function Items(props: { count: number; mode: string; control: Control; items: boolean; style: boolean; atomicItems?: AtomicItem[] }) {
  const [showItems, setShowItems] = createSignal(props.items)
  const [showStyle, setShowStyle] = createSignal(props.style)
  props.control.setShowItems = setShowItems
  props.control.setShowStyle = setShowStyle
  const [classIndex, setClassIndex] = createSignal(-1)
  const [dataIndex, setDataIndex] = createSignal(-1)
  const [all, setAll] = createSignal(false)
  const isClass = createSelector(classIndex)
  const isData = createSelector(dataIndex)
  props.control.setClassIndex = setClassIndex
  props.control.setDataIndex = setDataIndex
  props.control.setAll = setAll
  const indexes = Array.from({ length: props.count }, (_, index) => index)
  const [showSecond, setShowSecond] = createSignal(false)
  const [secondText, setSecondText] = createSignal(".other-1 { color: blue }")
  props.control.setShowSecond = setShowSecond
  props.control.setSecondText = setSecondText
  const sheetText =
    props.mode === "sheet" ? SHEET : props.mode === "inline+sheet" ? UNRELATED_SHEET : props.mode === "atomic" ? ATOMIC_SHEET : null
  const atomicItem = (index: number): AtomicItem => {
    const item = props.atomicItems?.[index]
    if (item === undefined) throw new Error(`mode ${props.mode} needs an atomic item at ${index}`)
    return item
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", width: WIDTH }}>
      {sheetText === null || !showStyle() ? null : <style>{sheetText}</style>}
      {showSecond() ? <style>{secondText()}</style> : null}
      <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", width: WIDTH }}>
        <For each={showItems() ? indexes : []}>
          {(index) =>
            props.mode === "attrs" ? (
              <div
                ref={(element: unknown) => (props.control.items[index] = element)}
                class="item"
                data-index={index}
                data-kind="cell"
                style={isClass(index) || isData(index) || all() ? ACTIVE : BASE}
              />
            ) : props.mode === "attrs-canvas" ? (
              <canvas
                ref={(element: unknown) => (props.control.items[index] = element)}
                class="item"
                data-index={index}
                data-kind="cell"
                style={isClass(index) || isData(index) || all() ? ACTIVE : BASE}
              />
            ) : props.mode === "runtime" ? (
              <div ref={(element: unknown) => (props.control.items[index] = element)} class={`item u${index}`} id={`i${index}`} />
            ) : props.mode === "atomic" ? (
              <div
                ref={(element: unknown) => (props.control.items[index] = element)}
                class={isClass(index) || all() ? atomicItem(index).classesB : atomicItem(index).classesA}
              />
            ) : props.mode === "atomic-inline" ? (
              <div
                ref={(element: unknown) => (props.control.items[index] = element)}
                style={isClass(index) || all() ? atomicItem(index).styleB : atomicItem(index).styleA}
              />
            ) : props.mode === "sheet" ? (
              <div
                ref={(element: unknown) => (props.control.items[index] = element)}
                class={isClass(index) || all() ? "item active" : "item"}
                data-active={isData(index) ? true : undefined}
              />
            ) : (
              <div
                ref={(element: unknown) => (props.control.items[index] = element)}
                style={isClass(index) || isData(index) || all() ? ACTIVE : BASE}
              />
            )
          }
        </For>
      </div>
    </div>
  )
}

interface Sample {
  /** the mutation and its batch apply only: Solid's update, the mutation queue's flush, native applyBatch with flush_styles */
  batchInstructions: number
  /** the part of the batch spent inside native `applyBatch`; the rest is the adapter's and the wire writer's */
  nativeInstructions: number
  batchMs: number
  /** the batch, then the view's flush and the frame that paints it */
  instructions: number
  ms: number
  rematched: number
  cascades: number
  /** (max - min) / median of the batch and of the end-to-end instructions, in percent, over the repetitions */
  batchSpread: number
  spread: number
}
const spreadOf = (values: number[]) => ((Math.max(...values) - Math.min(...values)) / Math.abs(median(values))) * 100
const summarize = (samples: Sample[]): Sample => ({
  batchInstructions: median(samples.map((s) => s.batchInstructions)),
  nativeInstructions: median(samples.map((s) => s.nativeInstructions)),
  batchMs: median(samples.map((s) => s.batchMs)),
  instructions: median(samples.map((s) => s.instructions)),
  ms: median(samples.map((s) => s.ms)),
  rematched: median(samples.map((s) => s.rematched)),
  cascades: median(samples.map((s) => s.cascades)),
  batchSpread: spreadOf(samples.map((s) => s.batchInstructions)),
  spread: spreadOf(samples.map((s) => s.instructions)),
})

const results: Record<string, Record<string, Record<string, Sample>>> = {}

let nativeInstructions = 0

function openRoot(count: number, itemWidth = ITEM_WIDTH + 8, rowHeight = ROW_HEIGHT) {
  const rows = Math.ceil(count / Math.floor(WIDTH / itemWidth))
  // Metal textures stop at 16384 px, and the window is one
  const app = createTestRoot({ width: WIDTH, height: Math.min(rows * rowHeight + 100, 16000), appearance: "light" })
  app.renderer.setA11yActive(false)
  app.renderer.clockPause()
  app.renderer.setInlineDraws(false)
  const applyBatch = app.renderer.applyBatch
  app.renderer.applyBatch = (wire) => {
    const before = readInstructions()
    const destroyed = applyBatch(wire)
    nativeInstructions += readInstructions() - before - readOverhead
    return destroyed
  }
  return app
}

function frame(app: ReturnType<typeof createTestRoot>) {
  app.renderer.clockAdvance(TICK_MS)
  app.renderer.dispatchNativeEvents()
  app.renderer.drawFrame()
}

/** `mutate` is the batch window; `paint` (the view's flush and the frame) runs after it, outside the batch numbers. */
function sample(app: ReturnType<typeof createTestRoot>, mutate: () => void, paint: () => void): Sample {
  app.renderer.resetBuildCounters()
  nativeInstructions = 0
  const t0 = performance.now()
  const a = readInstructions()
  mutate()
  const b = readInstructions()
  const t1 = performance.now()
  paint()
  const c = readInstructions()
  const t2 = performance.now()
  const counters = app.renderer.getBuildCounters()
  return {
    batchInstructions: b - a - readOverhead,
    nativeInstructions,
    batchMs: t1 - t0,
    instructions: c - a - 2 * readOverhead,
    ms: t2 - t0,
    rematched: counters.elementsRematched,
    cascades: counters.cascadesComputed,
    batchSpread: 0,
    spread: 0,
  }
}

function expectBackground(control: Control, index: number, expected: string, where: string) {
  const actual = getComputedStyle(control.items[index] as never).backgroundColor
  if (actual !== expected) throw new Error(`${where}: item ${index} has background ${actual}, expected ${expected}`)
}

const isAtomic = (mode: string) => mode.startsWith("atomic")
const atomicItemsByCount = new Map<number, AtomicItem[]>()
const atomicItemsOf = (count: number) => {
  const existing = atomicItemsByCount.get(count)
  if (existing !== undefined) return existing
  const built = buildAtomicItems(count)
  atomicItemsByCount.set(count, built)
  return built
}
const openRootOf = (mode: string, count: number) => (isAtomic(mode) ? openRoot(count, 60, 48) : openRoot(count))
/** background of item 0 at mount: the look every mode gives it */
const mountBackground = (mode: string, count: number) =>
  isAtomic(mode) ? rgbOf((atomicItemsOf(count)[0] as AtomicItem).backgroundA) : "rgb(59, 130, 246)"

function record(mode: string, count: number, phase: string, value: Sample) {
  const byMode = (results[mode] ??= {})
  const byCount = (byMode[String(count)] ??= {})
  byCount[phase] = value
}

function paintAfter(app: ReturnType<typeof createTestRoot>) {
  return () => {
    app.renderer.flush()
    frame(app)
  }
}

function runMode(mode: string, count: number) {
  const recordPhase = (phase: string, value: Sample) => record(mode, count, phase, value)
  const atomicItems = isAtomic(mode) ? atomicItemsOf(count) : undefined

  if (want("mount")) {
    // mount: a fresh root each repetition; the first 2 are unmeasured
    const mounts: Sample[] = []
    for (let i = 0; i < 2 + MOUNT_REPS; i++) {
      const app = openRootOf(mode, count)
      const control = newControl()
      app.render(() => <Items count={count} mode={mode} control={control} items={false} style={true} atomicItems={atomicItems} />)
      for (let frames = 0; frames < 3; frames++) frame(app)
      const measured = sample(app, () => app.root.flushSync(() => control.setShowItems(true)), paintAfter(app))
      expectBackground(control, 0, mountBackground(mode, count), `${mode} mount`)
      if (i >= 2) mounts.push(measured)
      app.unmount()
    }
    recordPhase("mount", summarize(mounts))
  }

  if (mode !== "inline" && mode !== "atomic-inline" && !mode.startsWith("attrs") && want("sheet-load")) {
    const app = openRootOf(mode, count)
    const control = newControl()
    app.render(() => <Items count={count} mode={mode} control={control} items={true} style={false} atomicItems={atomicItems} />)
    for (let i = 0; i < 5; i++) frame(app)
    const loads: Sample[] = []
    for (let i = 0; i < SETTLE + REPS; i++) {
      const measured = sample(app, () => app.root.flushSync(() => control.setShowStyle(true)), paintAfter(app))
      if (mode === "sheet" || mode === "atomic") expectBackground(control, 0, mountBackground(mode, count), `${mode} sheet-load`)
      if (i >= SETTLE) loads.push(measured)
      app.root.flushSync(() => control.setShowStyle(false))
      app.renderer.flush()
      frame(app)
    }
    recordPhase("sheet-load", summarize(loads))
    app.unmount()
  }

  const app = openRootOf(mode, count)
  const control = newControl()
  app.render(() => <Items count={count} mode={mode} control={control} items={true} style={true} atomicItems={atomicItems} />)
  for (let i = 0; i < 5; i++) frame(app)
  const toggle = (name: string, index: number, on: () => void, off: () => void, expectOn = ACTIVE_BACKGROUND, expectOff = "rgb(59, 130, 246)") => {
    if (!want(name)) return
    const samples: Sample[] = []
    for (let i = 0; i < SETTLE + REPS; i++) {
      const turnOn = i % 2 === 0
      const measured = sample(app, () => app.root.flushSync(turnOn ? on : off), paintAfter(app))
      expectBackground(control, index, turnOn ? expectOn : expectOff, `${mode} ${name} ${turnOn ? "on" : "off"}`)
      if (i >= SETTLE) samples.push(measured)
    }
    recordPhase(name, summarize(samples))
  }
  const middle = count >> 1
  if (atomicItems !== undefined) {
    const item = (index: number) => atomicItems[index] as AtomicItem
    toggle("swap-one", middle, () => control.setClassIndex(middle), () => control.setClassIndex(-1), rgbOf(item(middle).backgroundB), rgbOf(item(middle).backgroundA))
    toggle("swap-all", 0, () => control.setAll(true), () => control.setAll(false), rgbOf(item(0).backgroundB), rgbOf(item(0).backgroundA))
  } else {
    toggle("class", middle, () => control.setClassIndex(middle), () => control.setClassIndex(-1))
    toggle("data", middle, () => control.setDataIndex(middle), () => control.setDataIndex(-1))
    toggle("many", 0, () => control.setAll(true), () => control.setAll(false))
  }
  app.unmount()
}

/** N mounted items under an adopted sheet; CSSOM edits of it and a second `<style>` element, each an add and a remove */
function runSheetChanges(count: number) {
  const mode = "runtime"
  const recordPhase = (phase: string, value: Sample) => record(mode, count, phase, value)
  const app = openRoot(count)
  const control = newControl()
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(RUNTIME_SHEET)
  document.adoptedStyleSheets = [sheet]
  app.render(() => <Items count={count} mode={mode} control={control} items={true} style={false} />)
  for (let i = 0; i < 5; i++) frame(app)
  const middle = count >> 1
  const last = count - 1
  const white = "rgb(255, 255, 255)"
  const marked = "rgb(18, 52, 86)"
  const colorOf = (index: number) => getComputedStyle(control.items[index] as never).color
  const expectColor = (index: number, expected: string, where: string) => {
    const actual = colorOf(index)
    if (actual !== expected) throw new Error(`${where}: item ${index} has color ${actual}, expected ${expected}`)
  }
  const append = (rule: string) => void sheet.insertRule(rule, sheet.cssRules.length)
  const removeLast = () => sheet.deleteRule(sheet.cssRules.length - 1)
  const measure = (change: () => void) => sample(app, () => app.root.flushSync(change), paintAfter(app))

  /** `add` then `remove` each repetition, reported as two phases */
  const pair = (addName: string, removeName: string, add: () => void, remove: () => void, check: (added: boolean, where: string) => void) => {
    if (!want(addName) && !want(removeName)) return
    const added: Sample[] = []
    const removed: Sample[] = []
    for (let i = 0; i < SETTLE + REPS; i++) {
      const adding = measure(add)
      check(true, addName)
      const removing = measure(remove)
      check(false, removeName)
      if (i >= SETTLE) {
        added.push(adding)
        removed.push(removing)
      }
    }
    recordPhase(addName, summarize(added))
    recordPhase(removeName, summarize(removed))
  }
  const nothing = () => {}
  pair("insert-nomatch", "delete-nomatch", () => append(".nomatch-x { color: red }"), removeLast, nothing)
  pair("insert-one", "delete-one", () => append(`#i${middle} { color: #123456 }`), removeLast, (added, where) => {
    expectColor(middle, added ? marked : white, where)
    expectColor(last, white, where)
  })
  pair("insert-all", "delete-all", () => append(".item { color: #123456 }"), removeLast, (added, where) => {
    expectColor(0, added ? marked : white, where)
    expectColor(last, added ? marked : white, where)
  })

  /** one rule stays in the sheet and its value alternates between two, by deleteRule + insertRule in one flush */
  const edit = (name: string, selector: string, indexes: number[]) => {
    if (!want(name)) return
    append(`${selector} { color: #aa0000 }`)
    app.root.flushSync(nothing)
    frame(app)
    const samples: Sample[] = []
    for (let i = 0; i < SETTLE + REPS; i++) {
      const second = i % 2 === 0
      const position = sheet.cssRules.length - 1
      const measured = measure(() => {
        sheet.deleteRule(position)
        sheet.insertRule(`${selector} { color: ${second ? "#00aa00" : "#aa0000"} }`, position)
      })
      for (const index of indexes) expectColor(index, second ? "rgb(0, 170, 0)" : "rgb(170, 0, 0)", name)
      if (i >= SETTLE) samples.push(measured)
    }
    recordPhase(name, summarize(samples))
    removeLast()
    app.root.flushSync(nothing)
    frame(app)
  }
  edit("edit-all", ".item", [0, last])
  edit("edit-one", `#i${middle}`, [middle])

  if (want("replace-same")) {
    const samples: Sample[] = []
    for (let i = 0; i < SETTLE + REPS; i++) {
      const text = sheet.sheetText()
      const measured = measure(() => sheet.replaceSync(text))
      expectColor(0, white, "replace-same")
      if (i >= SETTLE) samples.push(measured)
    }
    recordPhase("replace-same", summarize(samples))
  }

  pair("style-add", "style-remove", () => control.setShowSecond(true), () => control.setShowSecond(false), nothing)
  if (want("style-text")) {
    app.root.flushSync(() => control.setShowSecond(true))
    frame(app)
    const samples: Sample[] = []
    for (let i = 0; i < SETTLE + REPS; i++) {
      const text = i % 2 === 0 ? ".other-1 { color: green }" : ".other-1 { color: blue }"
      const measured = measure(() => control.setSecondText(text))
      if (i >= SETTLE) samples.push(measured)
    }
    recordPhase("style-text", summarize(samples))
    app.root.flushSync(() => control.setShowSecond(false))
  }

  document.adoptedStyleSheets = []
  app.unmount()
}

for (const mode of MODES) for (const count of COUNTS) (mode === "runtime" ? runSheetChanges : (n: number) => runMode(mode, n))(count)

const M = (value: number) => (value / 1e6).toFixed(3)
console.log(`items ${ITEM_WIDTH} x ${ROW_HEIGHT} in a ${WIDTH}-wide wrapping row, REPS ${REPS} after ${SETTLE} unmeasured (mount ${MOUNT_REPS} after 2), rusage read overhead ${readOverhead} instr`)
console.log("mode\tphase\tN\tbatch Minstr\tnative Minstr\tbatch ms\tend-to-end Minstr\tend-to-end ms\tmatched\tcascades\tbatch spread %\te2e spread %")
for (const mode of Object.keys(results)) {
  for (const count of Object.keys(results[mode]!)) {
    for (const phase of Object.keys(results[mode]![count]!)) {
      const p = results[mode]![count]![phase]!
      console.log(`${mode}\t${phase}\t${count}\t${M(p.batchInstructions)}\t${M(p.nativeInstructions)}\t${p.batchMs.toFixed(2)}\t${M(p.instructions)}\t${p.ms.toFixed(2)}\t${p.rematched}\t${p.cascades}\t${p.batchSpread.toFixed(0)}\t${p.spread.toFixed(0)}`)
    }
  }
}
if (process.env.JSON === "1") console.log(JSON.stringify(results))
process.exit(0)
