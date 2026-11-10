// Stylesheet cost: N items styled by the inline `style` prop against the same look from a stylesheet class rule, on the test
// renderer's window kind, in one process. Items are ~52 x 24 boxes in a wrapping flex container, so every one is laid out,
// built and painted. The sheet's rules say the same eight declarations the inline objects do.
//
// Run, from examples/ (its Vite config compiles the Solid files), with a release addon and ONE mode per process, so a mode starts
// in a fresh process (JIT and allocator state are not shared):
//   cd examples && for m in inline sheet inline+sheet; do MODES=$m COUNTS=1000,5000 REPS=15 bun run profile-stylesheet-cost; done
// Instructions are the process's ri_instructions (native threads included), one read around each stage, as row-cost does.
//
// Env:
//   COUNTS=1000,5000   items of each run
//   REPS=15            measured repetitions of each phase (after SETTLE=3 unmeasured ones); mount repeats MOUNT_REPS=7 times
//   MODES=inline,sheet,inline+sheet   what runs, in this order, in this process
//   JSON=1             prints the results as JSON on the last line
//
// Phases. Each is reported twice: "batch" is only the mutation and its batch apply (Solid's update, the mutation queue's flush,
// native applyBatch with flush_styles; for mount the whole `root.render`), and "end-to-end" adds the view's flush and the frame that
// paints it, which runs after the batch window closes:
//   mount  a fresh root: render N items and draw the first frame
//   class  one item's class gains / loses `active` (inline: its style object is swapped)
//   data   one item's data-active attribute is set / removed (inline: its style object is swapped)
//   many   all N items at once, on and off (class on all / style on all)
// `matched` and `cascades` (counted over the whole phase) are the build counters elementsRematched and cascadesComputed of one repetition (sheet modes).
import { dlopen, ptr } from "bun:ffi"
import { For, createSelector, createSignal } from "solid-js"
import type { StyleDesc } from "@ghia/solid"
import { getComputedStyle } from "@ghia/native/host"
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

interface Control {
  setClassIndex(index: number): void
  setDataIndex(index: number): void
  setAll(on: boolean): void
  items: unknown[]
}

const newControl = (): Control => ({
  setClassIndex: () => { throw new Error("not rendered") },
  setDataIndex: () => { throw new Error("not rendered") },
  setAll: () => { throw new Error("not rendered") },
  items: [],
})

function Items(props: { count: number; mode: string; control: Control }) {
  const [classIndex, setClassIndex] = createSignal(-1)
  const [dataIndex, setDataIndex] = createSignal(-1)
  const [all, setAll] = createSignal(false)
  const isClass = createSelector(classIndex)
  const isData = createSelector(dataIndex)
  props.control.setClassIndex = setClassIndex
  props.control.setDataIndex = setDataIndex
  props.control.setAll = setAll
  const indexes = Array.from({ length: props.count }, (_, index) => index)
  const sheetText = props.mode === "sheet" ? SHEET : props.mode === "inline+sheet" ? UNRELATED_SHEET : null
  return (
    <div style={{ display: "flex", flexDirection: "column", width: WIDTH }}>
      {sheetText === null ? null : <style>{sheetText}</style>}
      <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", width: WIDTH }}>
        <For each={indexes}>
          {(index) =>
            props.mode === "sheet" ? (
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
  batchMs: number
  /** the batch, then the view's flush and the frame that paints it */
  instructions: number
  ms: number
  rematched: number
  cascades: number
}
const summarize = (samples: Sample[]): Sample => ({
  batchInstructions: median(samples.map((s) => s.batchInstructions)),
  batchMs: median(samples.map((s) => s.batchMs)),
  instructions: median(samples.map((s) => s.instructions)),
  ms: median(samples.map((s) => s.ms)),
  rematched: median(samples.map((s) => s.rematched)),
  cascades: median(samples.map((s) => s.cascades)),
})

const results: Record<string, Record<string, Record<string, Sample>>> = {}

function openRoot(count: number) {
  const rows = Math.ceil(count / Math.floor(WIDTH / (ITEM_WIDTH + 8)))
  const app = createTestRoot({ width: WIDTH, height: rows * ROW_HEIGHT + 100, appearance: "light" })
  app.renderer.setA11yActive(false)
  app.renderer.clockPause()
  app.renderer.setInlineDraws(false)
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
    batchMs: t1 - t0,
    instructions: c - a - 2 * readOverhead,
    ms: t2 - t0,
    rematched: counters.elementsRematched,
    cascades: counters.cascadesComputed,
  }
}

function expectBackground(control: Control, index: number, expected: string, where: string) {
  const actual = getComputedStyle(control.items[index] as never).backgroundColor
  if (actual !== expected) throw new Error(`${where}: item ${index} has background ${actual}, expected ${expected}`)
}

function runMode(mode: string, count: number) {
  const record = (phase: string, value: Sample) => {
    const byMode = (results[mode] ??= {})
    const byCount = (byMode[String(count)] ??= {})
    byCount[phase] = value
  }

  // mount: a fresh root each repetition; the first MOUNT_SETTLE are unmeasured
  const mounts: Sample[] = []
  for (let i = 0; i < 2 + MOUNT_REPS; i++) {
    const app = openRoot(count)
    const control = newControl()
    const measured = sample(
      app,
      () => app.root.render(() => <Items count={count} mode={mode} control={control} />),
      () => {
        app.renderer.flush()
        frame(app)
      }
    )
    expectBackground(control, 0, "rgb(59, 130, 246)", `${mode} mount`)
    if (i >= 2) mounts.push(measured)
    app.unmount()
  }
  record("mount", summarize(mounts))

  const app = openRoot(count)
  const control = newControl()
  app.render(() => <Items count={count} mode={mode} control={control} />)
  for (let i = 0; i < 5; i++) frame(app)
  const toggle = (name: string, index: number, on: () => void, off: () => void) => {
    const samples: Sample[] = []
    for (let i = 0; i < SETTLE + REPS; i++) {
      const turnOn = i % 2 === 0
      const measured = sample(
        app,
        () => app.root.flushSync(turnOn ? on : off),
        () => {
          app.renderer.flush()
          frame(app)
        }
      )
      expectBackground(control, index, turnOn ? ACTIVE_BACKGROUND : "rgb(59, 130, 246)", `${mode} ${name} ${turnOn ? "on" : "off"}`)
      if (i >= SETTLE) samples.push(measured)
    }
    record(name, summarize(samples))
  }
  const middle = count >> 1
  toggle("class", middle, () => control.setClassIndex(middle), () => control.setClassIndex(-1))
  toggle("data", middle, () => control.setDataIndex(middle), () => control.setDataIndex(-1))
  toggle("many", 0, () => control.setAll(true), () => control.setAll(false))
  app.unmount()
}

for (const mode of MODES) for (const count of COUNTS) runMode(mode, count)

const M = (value: number) => (value / 1e6).toFixed(3)
console.log(`items ${ITEM_WIDTH} x ${ROW_HEIGHT} in a ${WIDTH}-wide wrapping row, REPS ${REPS} after ${SETTLE} unmeasured (mount ${MOUNT_REPS} after 2), rusage read overhead ${readOverhead} instr`)
console.log("mode\tphase\tN\tbatch Minstr\tbatch ms\tend-to-end Minstr\tend-to-end ms\tmatched\tcascades")
for (const mode of Object.keys(results)) {
  for (const count of Object.keys(results[mode]!)) {
    for (const phase of Object.keys(results[mode]![count]!)) {
      const p = results[mode]![count]![phase]!
      console.log(`${mode}\t${phase}\t${count}\t${M(p.batchInstructions)}\t${p.batchMs.toFixed(2)}\t${M(p.instructions)}\t${p.ms.toFixed(2)}\t${p.rematched}\t${p.cascades}`)
    }
  }
}
if (process.env.JSON === "1") console.log(JSON.stringify(results))
process.exit(0)
