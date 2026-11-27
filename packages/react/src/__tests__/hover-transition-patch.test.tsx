// @ts-nocheck
/**
 * A hover that only paints and whose element declares a transition that runs on colours is drawn by patch frames: the hover
 * is a patch that builds the root (which starts the transition), and every tick of the run builds it again, as a tick of
 * a CSS transition on a page that was built whole (`events/hover_paint.rs`, patch-frames.md "Hover patches"). A transition that can
 * run on more than a colour (`all`, `opacity`) leaves the hover to a frame built whole. What the page shows is what patching
 * off draws at the same instant, and the events of the run fire when they are due.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a patch is compared with the frame built whole after it, and a frame that replays roots is built twice:
// the cases that count frames skip there, and every case checks `mismatches`.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROW = 40
const COUNT = 6
const DURATION = 200
const FRAME = 16
const TIMEOUT = 60_000
/** Over the row 1, and outside every row. */
const ON = [20, 60] as const
const OFF = [250, 230] as const

/** The transition of a row, and what its hover changes. */
type Variant = "background" | "colour" | "all" | "opacity" | "child" | "none"

const TRANSITIONS: Record<Variant, string | undefined> = {
  background: `background-color ${DURATION}ms linear`,
  colour: `color ${DURATION}ms linear, background-color ${DURATION}ms linear`,
  all: `all ${DURATION}ms linear`,
  opacity: `opacity ${DURATION}ms linear`,
  child: undefined,
  none: undefined,
}

function Row({ index, variant, seen }: { index: number; variant: Variant; seen: string[] }) {
  const style =
    variant === "child"
      ? { width: 150, height: ROW, flexShrink: 0, color: "#ffffff", backgroundColor: "#223344", hover: { color: "#ff0000" } }
      : variant === "colour"
        ? {
            width: 150,
            height: ROW,
            flexShrink: 0,
            color: "#ffffff",
            backgroundColor: "#223344",
            transition: TRANSITIONS.colour,
            hover: { color: "#ff0000", backgroundColor: "#664422" },
          }
        : {
          width: 150,
          height: ROW,
          flexShrink: 0,
          backgroundColor: "#223344",
          borderBottom: "1px solid #112233",
          transition: TRANSITIONS[variant],
          hover: { backgroundColor: "#664422" },
        }
  return (
    <div
      testId={`row-${index}`}
      style={style}
      onTransitionEnd={(event) => seen.push(`end ${index} ${event.propertyName}`)}
      onTransitionRun={(event) => seen.push(`run ${index} ${event.propertyName}`)}
    >
      <div
        style={{
          color: variant === "child" || variant === "colour" ? undefined : "#ffffff",
          transition: variant === "child" ? `color ${DURATION}ms linear` : undefined,
        }}
      >{`row-${index}`}</div>
    </div>
  )
}

function Page({ variant, seen }: { variant: Variant; seen: string[] }) {
  return (
    <div testId="column" style={{ width: 200, height: ROW * COUNT, flexDirection: "column", overflow: "hidden" }}>
      {Array.from({ length: COUNT }, (_, index) => (
        <Row key={index} index={index} variant={variant} seen={seen} />
      ))}
    </div>
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
  // Frames that record the page, and one run of the transition of a row, so the rows are known to the frames that follow.
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

/** Time passes for the window without it being told, a frame at a time, as it does in a live one. */
function elapse(renderer, ms: number) {
  for (let left = ms; left > 0; left -= FRAME) {
    renderer.clockAdvance(Math.min(FRAME, left))
    renderer.drawFrame()
  }
}

/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer, name: string): string {
  const file = `${SHOTS_DIR}/hover-transition-patch-${process.pid}-${name}.png`
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
    sceneRebuilds: patches.sceneRebuilds,
    refused: sum(patches.declines) + sum(patches.unpatchable),
    painted: renderer.getPaintedFrameCount(),
  }
}

/** What `step` did, in frames. */
function frames(renderer, step: () => void) {
  const before = counters(renderer)
  step()
  const after = counters(renderer)
  return {
    patched: after.patchedFrames - before.patchedFrames,
    sceneRebuilds: after.sceneRebuilds - before.sceneRebuilds,
    refused: after.refused - before.refused,
    painted: after.painted - before.painted,
  }
}

/** The page at the instants of a hover and a leave: `at` ticks after the pointer entered the row, or after it left. */
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
    const shown = picture(renderer, `${variant}-${patch}-${instant.name}`)
    return { shown, mismatches: renderer.getRetainedCounters().mismatches }
  } finally {
    root.unmount()
  }
}

describeNative("a hover whose element transitions colours", { timeout: TIMEOUT }, () => {
  for (const variant of ["background", "colour"] as const) {
    unverified(`is a patched frame, then a patched frame for every tick of the run, and likewise for the leave, with ${variant}`, async () => {
      const root = await open(variant, true)
      const renderer = root.renderer
      try {
        // The test window draws the tick the hover asks for in the same step, so the hover is up to two patched frames.
        const enter = frames(renderer, () => move(renderer, ...ON))
        expect(enter.patched, "the hover").toBeGreaterThanOrEqual(1)
        expect(enter.patched).toBeLessThanOrEqual(2)
        expect(enter.painted, "no frame is built whole").toBe(0)
        expect(enter.refused).toBe(0)
        expect(enter.sceneRebuilds).toBe(0)

        // The transition is 200 ms: 12 ticks of 16 ms are 192 of it.
        const run = frames(renderer, () => elapse(renderer, FRAME * 12))
        expect(run.patched, "every tick of the run").toBe(12)
        expect(run.painted).toBe(0)
        expect(run.refused).toBe(0)
        expect(run.sceneRebuilds).toBe(0)

        const end = frames(renderer, () => elapse(renderer, FRAME))
        expect(end.patched, "the tick that ends it").toBe(1)
        expect(end.painted).toBe(0)
        const after = frames(renderer, () => elapse(renderer, FRAME * 6))
        expect(after.patched, "a transition that ended asks for no tick").toBe(0)
        expect(after.painted).toBe(0)

        const leave = frames(renderer, () => move(renderer, ...OFF))
        expect(leave.patched, "the leave").toBeGreaterThanOrEqual(1)
        expect(leave.patched).toBeLessThanOrEqual(2)
        expect(leave.painted).toBe(0)
        const back = frames(renderer, () => elapse(renderer, FRAME * 13))
        expect(back.patched, "the run back").toBeGreaterThanOrEqual(12)
        expect(back.patched).toBeLessThanOrEqual(13)
        expect(back.painted).toBe(0)
        expect(back.refused).toBe(0)
        expect(renderer.getRetainedCounters().mismatches).toBe(0)
      } finally {
        root.unmount()
      }
    })

    it(`fires the events of the run when they are due, with ${variant}`, async () => {
      const seen: string[] = []
      const root = await open(variant, true, seen)
      const renderer = root.renderer
      const ends = () => seen.filter((event) => event.startsWith("end")).sort()
      const expected = variant === "background" ? ["end 1 background-color"] : ["end 1 background-color", "end 1 color"]
      try {
        move(renderer, ...ON)
        renderer.dispatchNativeEvents()
        expect(seen.filter((event) => event.startsWith("run 1")), "a run per property").toHaveLength(expected.length)
        elapse(renderer, FRAME * 12)
        renderer.dispatchNativeEvents()
        expect(ends(), "not at 192 ms").toEqual([])
        elapse(renderer, FRAME)
        renderer.dispatchNativeEvents()
        expect(ends(), "at 208 ms").toEqual(expected)
        seen.length = 0
        move(renderer, ...OFF)
        elapse(renderer, FRAME * 12)
        renderer.dispatchNativeEvents()
        expect(ends(), "not at 192 ms of the leave").toEqual([])
        elapse(renderer, FRAME)
        renderer.dispatchNativeEvents()
        expect(ends(), "at 208 ms of the leave").toEqual(expected)
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
      expect(end.shown).not.toEqual(start.shown)
    })
  }

  // A colour a child inherits is not one it transitions (the engine starts a transition from the element's own change), and the
  // hover that changes it is a patched frame that shows what patching off shows.
  unverified("is a patched frame when the colour is one a child with a transition of colour inherits", async () => {
    const root = await open("child", true)
    try {
      const enter = frames(root.renderer, () => move(root.renderer, ...ON))
      expect(enter.patched).toBeGreaterThanOrEqual(1)
      expect(enter.painted).toBe(0)
      expect(enter.refused).toBe(0)
    } finally {
      root.unmount()
    }
  })

  for (const instant of INSTANTS.filter((instant) => ["enter", "enter-6", "leave-6"].includes(instant.name))) {
    it(`shows what patching off shows for a colour a child with a transition inherits, at ${instant.name}`, async () => {
      const on = await pictureAt("child", true, instant)
      const off = await pictureAt("child", false, instant)
      expect(on.shown === off.shown).toBe(true)
      expect(on.mismatches).toBe(0)
    })
  }

  for (const variant of ["all", "opacity"] as const) {
    unverified(`stays a frame built whole when the transition can run on more than a colour, with ${variant}`, async () => {
      const root = await open(variant, true)
      const renderer = root.renderer
      try {
        const enter = frames(renderer, () => move(renderer, ...ON))
        expect(enter.painted, "the hover is a frame built whole").toBeGreaterThan(0)
      } finally {
        root.unmount()
      }
    })

    it(`shows what patching off shows when the transition can run on more than a colour, with ${variant}`, async () => {
      for (const instant of INSTANTS.filter((instant) => ["enter-6", "leave-6"].includes(instant.name))) {
        const on = await pictureAt(variant, true, instant)
        const off = await pictureAt(variant, false, instant)
        expect(on.shown === off.shown, instant.name).toBe(true)
      }
    })
  }

  unverified("keeps a hover with no transition a patched frame, as it was", async () => {
    const root = await open("none", true)
    try {
      const enter = frames(root.renderer, () => move(root.renderer, ...ON))
      expect(enter.patched).toBe(1)
      expect(enter.painted).toBe(0)
    } finally {
      root.unmount()
    }
  })
})
