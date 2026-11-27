// @ts-nocheck
/**
 * Tailwind's `transition-colors` on an element whose hover only paints: the list it names (v4 `color, background-color,
 * border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via,
 * --tw-gradient-to`, v3 the colours, `fill` and `stroke`), with the duration and the timing function of v4 as `var()`s,
 * only runs on colours, so the hover is a patch frame and every tick of the run is one (`motion::transitions_only_colours`,
 * patch-frames.md "Hover patches"). What the page shows is what patching off draws at the same instant, an `<svg>` icon
 * that paints with `currentColor` or a `fill` of its own included, and a hover that changes a gradient's custom property
 * is a frame built whole that shows the same.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { flushSync } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROW = 40
const COUNT = 6
const DURATION = 200
const FRAME = 16
const TIMEOUT = 60_000
const ON = [20, 60] as const
const OFF = [250, 230] as const

const V4_PROPERTY =
  "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to"
const V3_PROPERTY = "color, background-color, border-color, text-decoration-color, fill, stroke"
const V4_TIMING = "var(--tw-ease, var(--default-transition-timing-function))"
const V4_DURATION = "var(--tw-duration, var(--default-transition-duration))"

/** `transition-colors` as v4 writes it: the duration and the timing function come from custom properties. */
const V4 = { transitionProperty: V4_PROPERTY, transitionTimingFunction: V4_TIMING, transitionDuration: V4_DURATION }
const V3 = { transitionProperty: V3_PROPERTY, transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)", transitionDuration: `${DURATION}ms` }

const SHEET = `
  .transition-colors {
    transition-property: ${V4_PROPERTY};
    transition-timing-function: ${V4_TIMING};
    transition-duration: ${V4_DURATION};
  }
  .row { width: 150px; height: ${ROW}px; flex-shrink: 0; color: #ffffff; background-color: #223344; border-bottom: 1px solid #112233 }
  .row:hover { color: #ff0000; background-color: #664422 }
  .vrow { --c1: #223344; --c2: #664422; --c3: #ffffff; --c4: #ff0000; width: 150px; height: ${ROW}px; flex-shrink: 0; color: var(--c3); background-color: var(--c1) }
  .vrow:hover { color: var(--c4); background-color: var(--c2) }
`

type Variant = "v4" | "v3" | "sheet" | "sheet-vars" | "icon" | "icon-own" | "icon-fill" | "gradient" | "all"

const REST = "#223344"
const TINT = "#443322"

let tintRows!: (tinted: boolean) => void

const ICON = "M2 2 L14 2 L14 14 L2 14 Z"

function Icon(props: { variant: Variant; filled: boolean }) {
  if (props.variant === "icon-fill") {
    // The shape has a `fill` of its own that a commit changes, under a transition of fill: a run that is no hover's.
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" style={{ width: 16, height: 16, flexShrink: 0 }}>
        <path d={ICON} fill={props.filled ? "#00ff00" : "#0000ff"} stroke="currentColor" strokeWidth={2} style={{ transition: `fill ${DURATION}ms linear` }} />
      </svg>
    )
  }
  const own = props.variant === "icon-own" ? { transitionProperty: V4_PROPERTY, transitionDuration: `${DURATION}ms`, transitionTimingFunction: "linear" } : undefined
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" style={{ width: 16, height: 16, flexShrink: 0, ...own }}>
      <path d={ICON} fill="currentColor" stroke="currentColor" strokeWidth={1} />
    </svg>
  )
}

function Row(props: { index: number; variant: Variant; seen: string[]; tint: boolean }) {
  if (props.variant === "sheet-vars") {
    return (
      <div testId={`row-${props.index}`} className="vrow transition-colors">
        {`row-${props.index}`}
      </div>
    )
  }
  if (props.variant === "sheet") {
    return (
      <div testId={`row-${props.index}`} className="row transition-colors">
        {`row-${props.index}`}
      </div>
    )
  }
  const base = {
    width: 150,
    height: ROW,
    flexShrink: 0,
    color: "#ffffff",
    backgroundColor: props.tint ? TINT : REST,
    borderBottom: "1px solid #112233",
    hover: { color: "#ff0000", backgroundColor: "#664422" },
  }
  const style =
    props.variant === "v3"
      ? { ...base, ...V3 }
      : props.variant === "all"
        ? { ...base, transition: `all ${DURATION}ms linear` }
        : props.variant === "gradient"
          ? {
              ...base,
              "--tw-gradient-from": "#223344",
              "--tw-gradient-to": "#664422",
              backgroundColor: undefined,
              backgroundImage: "linear-gradient(to right, var(--tw-gradient-from), var(--tw-gradient-to))",
              hover: { "--tw-gradient-from": "#ff8800" },
              ...V4,
            }
          : { ...base, ...V4 }
  const icon = props.variant.startsWith("icon")
  return (
    <div
      testId={`row-${props.index}`}
      style={{ ...style, flexDirection: "row", alignItems: "center", gap: 4 }}
      onTransitionRun={(event) => props.seen.push(`run ${props.index} ${event.propertyName}`)}
      onTransitionEnd={(event) => props.seen.push(`end ${props.index} ${event.propertyName}`)}
    >
      {icon ? <Icon variant={props.variant} filled={props.tint} /> : null}
      <div>{`row-${props.index}`}</div>
    </div>
  )
}

function Page(props: { variant: Variant; seen: string[] }) {
  const [tinted, setTinted] = React.useState(false)
  tintRows = (next) => flushSync(() => setTinted(next))
  return (
    <>
      {props.variant === "sheet" || props.variant === "sheet-vars" ? <style>{SHEET}</style> : null}
      <div
        testId="column"
        style={{
          width: 200,
          height: ROW * COUNT,
          flexDirection: "column",
          overflow: "hidden",
          "--default-transition-duration": `${DURATION}ms`,
          "--default-transition-timing-function": "cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        {Array.from({ length: COUNT }, (_, index) => (
          <Row key={index} index={index} variant={props.variant} seen={props.seen} tint={tinted && index === 1} />
        ))}
      </div>
    </>
  )
}

async function open(variant: Variant, patch: boolean, seen: string[] = []) {
  const root = createTestRoot({ width: 300, height: 260 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(<Page variant={variant} seen={seen} />)
  renderer.dispatchNativeEvents()
  renderer.flush()
  renderer.setA11yActive(false)
  renderer.setPatchEnabled(patch)
  move(renderer, ...ON)
  elapse(renderer, DURATION + FRAME * 2)
  move(renderer, ...OFF)
  elapse(renderer, DURATION + FRAME * 2)
  renderer.dispatchNativeEvents()
  seen.length = 0
  return root
}

function move(renderer, x: number, y: number) {
  renderer.nativeSimulateMouseMove(x, y)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

function elapse(renderer, ms: number) {
  for (let left = ms; left > 0; left -= FRAME) {
    renderer.clockAdvance(Math.min(FRAME, left))
    renderer.drawFrame()
  }
}

function picture(renderer, name: string): string {
  const file = `${SHOTS_DIR}/hover-transition-tailwind-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

const sum = (reasons: string) => Object.values(JSON.parse(reasons)).reduce((a: number, b: number) => a + b, 0)

function counters(renderer) {
  const patches = renderer.getPatchCounters()
  return {
    patchedFrames: patches.patchedFrames,
    refused: sum(patches.declines) + sum(patches.unpatchable),
    painted: renderer.getPaintedFrameCount(),
  }
}

function frames(renderer, step: () => void) {
  const before = counters(renderer)
  step()
  const after = counters(renderer)
  return {
    patched: after.patchedFrames - before.patchedFrames,
    refused: after.refused - before.refused,
    painted: after.painted - before.painted,
  }
}

const INSTANTS = [
  { name: "enter", leave: false, ticks: 0 },
  { name: "enter-6", leave: false, ticks: 6 },
  { name: "enter-12", leave: false, ticks: 12 },
  { name: "enter-20", leave: false, ticks: 20 },
  { name: "leave", leave: true, ticks: 0 },
  { name: "leave-6", leave: true, ticks: 6 },
  { name: "leave-20", leave: true, ticks: 20 },
] as const

async function pictureAt(variant: Variant, patch: boolean, instant: (typeof INSTANTS)[number]) {
  const root = await open(variant, patch)
  const renderer = root.renderer
  try {
    move(renderer, ...ON)
    if (instant.leave) {
      elapse(renderer, DURATION + FRAME * 2)
      move(renderer, ...OFF)
    }
    elapse(renderer, instant.ticks * FRAME)
    return { shown: picture(renderer, `${variant}-${patch}-${instant.name}`), mismatches: renderer.getRetainedCounters().mismatches }
  } finally {
    root.unmount()
  }
}

const PATCHED: Variant[] = ["v4", "v3", "sheet", "icon", "icon-own", "icon-fill"]

describeNative("a hover whose element has Tailwind's transition-colors", { timeout: TIMEOUT }, () => {
  for (const variant of PATCHED) {
    unverified(`is a patched frame, then one for every tick of the run, and likewise for the leave, with ${variant}`, async () => {
      const root = await open(variant, true)
      const renderer = root.renderer
      try {
        const enter = frames(renderer, () => move(renderer, ...ON))
        expect(enter.patched, "the hover").toBeGreaterThanOrEqual(1)
        expect(enter.patched).toBeLessThanOrEqual(2)
        expect(enter.painted, "no frame is built whole").toBe(0)
        expect(enter.refused).toBe(0)

        const run = frames(renderer, () => elapse(renderer, FRAME * 12))
        expect(run.patched, "every tick of the run").toBe(12)
        expect(run.painted).toBe(0)
        expect(run.refused).toBe(0)

        const end = frames(renderer, () => elapse(renderer, FRAME))
        expect(end.patched, "the tick that ends it").toBe(1)
        expect(frames(renderer, () => elapse(renderer, FRAME * 6)).patched, "a transition that ended asks for no tick").toBe(0)

        const leave = frames(renderer, () => move(renderer, ...OFF))
        expect(leave.patched, "the leave").toBeGreaterThanOrEqual(1)
        expect(leave.painted).toBe(0)
        const back = frames(renderer, () => elapse(renderer, FRAME * 13))
        expect(back.patched, "the run back").toBeGreaterThanOrEqual(12)
        expect(back.painted).toBe(0)
        expect(back.refused).toBe(0)
        expect(renderer.getRetainedCounters().mismatches).toBe(0)
      } finally {
        root.unmount()
      }
    })

    for (const instant of INSTANTS) {
      it(`shows what patching off shows at ${instant.name}, with ${variant}`, async () => {
        const on = await pictureAt(variant, true, instant)
        const off = await pictureAt(variant, false, instant)
        expect(on.shown === off.shown).toBe(true)
        expect(on.mismatches).toBe(0)
      })
    }

    it(`shows a run in progress that is neither end of it, with ${variant}`, async () => {
      const start = await pictureAt(variant, true, INSTANTS[0])
      const middle = await pictureAt(variant, true, INSTANTS[1])
      const end = await pictureAt(variant, true, INSTANTS[3])
      expect(middle.shown).not.toEqual(start.shown)
      expect(middle.shown).not.toEqual(end.shown)
    })
  }

  it("runs the transition the hover starts on both colours, with the duration of a var()", async () => {
    const seen: string[] = []
    const root = await open("v4", true, seen)
    const renderer = root.renderer
    try {
      move(renderer, ...ON)
      renderer.dispatchNativeEvents()
      expect(seen.filter((event) => event.startsWith("run 1")).sort()).toEqual(["run 1 background-color", "run 1 color"])
      elapse(renderer, FRAME * 12)
      renderer.dispatchNativeEvents()
      expect(seen.filter((event) => event.startsWith("end")), "not at 192 ms").toEqual([])
      elapse(renderer, FRAME)
      renderer.dispatchNativeEvents()
      expect(seen.filter((event) => event.startsWith("end")).sort(), "at 208 ms").toEqual(["end 1 background-color", "end 1 color"])
    } finally {
      root.unmount()
    }
  })

  unverified("stays a frame built whole with a transition of `all`", async () => {
    const root = await open("all", true)
    try {
      expect(frames(root.renderer, () => move(root.renderer, ...ON)).painted).toBeGreaterThan(0)
    } finally {
      root.unmount()
    }
  })

  for (const instant of INSTANTS.filter((instant) => ["enter-6", "enter-12", "leave-6"].includes(instant.name))) {
    // `sheet-vars` is Tailwind v4's own output for the colours (`background-color: var(--color-...)`): a `var()` in a colour is
    // a frame built whole (`restyles_beyond_hover`) whatever the transition is, and shows what patching off shows.
    for (const variant of ["gradient", "all", "sheet-vars"] as const) {
      it(`shows what patching off shows at ${instant.name}, with ${variant}`, async () => {
        const on = await pictureAt(variant, true, instant)
        const off = await pictureAt(variant, false, instant)
        expect(on.shown === off.shown).toBe(true)
        expect(on.mismatches).toBe(0)
      })
    }
  }

  it("shows what patching off shows for a fill that a commit changes under a hover run, with an icon whose fill transitions", async () => {
    const pictures = []
    for (const patch of [true, false]) {
      const root = await open("icon-fill", patch)
      const renderer = root.renderer
      try {
        const shots: string[] = []
        const snap = (name: string) => shots.push(picture(renderer, `fill-${patch}-${name}`))
        move(renderer, ...ON)
        elapse(renderer, FRAME * 3)
        tintRows(true)
        renderer.drawFrame()
        snap("committed")
        for (const ticks of [3, 3, 3, 3, 6]) {
          elapse(renderer, FRAME * ticks)
          snap(`after-${ticks}`)
        }
        move(renderer, ...OFF)
        elapse(renderer, FRAME * 5)
        snap("left")
        elapse(renderer, FRAME * 12)
        snap("end")
        pictures.push({ shots, mismatches: renderer.getRetainedCounters().mismatches })
      } finally {
        root.unmount()
      }
    }
    pictures[0].shots.forEach((shot, at) => expect(shot === pictures[1].shots[at], `picture ${at}`).toBe(true))
    expect(pictures[0].mismatches).toBe(0)
  })
})
