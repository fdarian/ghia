// @ts-nocheck
/**
 * A frame that moves the rows of a list in place builds nothing, so a tick that is due in the same draw (a transition, an
 * animation, a motion value, the blink of a caret) would be taken by it and nothing would ask for the next: what follows the
 * clock would stand still until a frame built whole. Such a draw is a whole frame (`reasons.Clock`), and a frame after one
 * that asked for another is too. The picture, and the events of what runs, are what they are with the translate off.
 *
 * Time moves as a display link would move it: a vsync moves the clock of the window and the executor's together, then the
 * wheel event of the tick arrives and the frame is drawn.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its
// rows are built, not replayed, so there is nothing to translate after it (see `scroll-patch-translate.test.tsx`).
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const VSYNC = 16
const TIMEOUT = 120_000

function Page({ hot, onEnd, field }: { hot: boolean; onEnd: () => void; field: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 400, height: 200 }}>
      <div
        testId="beside"
        onTransitionEnd={onEnd}
        style={{ position: "absolute", left: 220, top: 40, width: 100, height: 40, backgroundColor: hot ? "#ff0000" : "#223344", transition: "background-color 150ms linear" }}
      />
      {field ? <input testId="field" defaultValue="caret" style={{ width: 100, height: 24, flexShrink: 0 }} /> : null}
      <virtual-list testId="list" itemCount={COUNT} estimatedItemHeight={ROW} overdraw={0} style={{ width: 200, height: VIEWPORT, scrollbarWidth: "none" }}>
        {Array.from({ length: COUNT }, (_, index) => (
          <div
            key={index}
            testId={`row-${index}`}
            style={{
              width: 150,
              height: ROW,
              flexShrink: 0,
              backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
            }}
          >
            <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
          </div>
        ))}
      </virtual-list>
    </div>
  )
}

/** A display-link tick `ms` later with a wheel event of `by` in it, if any, and the frame it draws. The pointer is in the gutter of the list. */
function tick(renderer, by: number | undefined, ms = VSYNC) {
  renderer.clockAdvance(ms)
  renderer.advanceTime(ms)
  if (by !== undefined) renderer.nativeSimulateScrollWheel(180, 80, 0, by)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

let shots = 0
/** The frame that was drawn last as it is: a frame that moved the rows in place is not built again to be captured. */
function picture(renderer): string {
  const file = `${SHOTS_DIR}/scroll-patch-clock-${process.pid}-${shots++}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

const scroll = (renderer) => renderer.getPatchCounters().scrollPatch

function open(translate: boolean, field: boolean, onEnd: () => void = () => {}) {
  const root = createTestRoot({ width: 400, height: 200 })
  const renderer = root.renderer
  renderer.clockPause()
  const page = (hot: boolean) => <Page hot={hot} onEnd={onEnd} field={field} />
  root.render(page(false))
  for (let frame = 0; frame < 3; frame++) {
    renderer.flush()
    renderer.dispatchNativeEvents()
  }
  renderer.setA11yActive(false)
  renderer.setInlineDraws(false)
  renderer.drawFrame()
  renderer.drawFrame()
  renderer.setScrollPatchEnabled(translate)
  return { ...root, renderer, heat: () => root.render(page(true)) }
}

describeNative("a tick due in the draw of a scroll", { timeout: TIMEOUT }, () => {
  /** A transition of a box beside the list that runs while the list scrolls by a pixel or two a tick, the pictures and its events. */
  function transition(translate: boolean) {
    const ends: string[] = []
    const { renderer, unmount, heat } = open(translate, false, () => ends.push("end"))
    try {
      // A wheel and its way back record the rows.
      tick(renderer, 4)
      tick(renderer, -4)
      tick(renderer, 1)
      heat()
      const pictures: string[] = []
      // 150 ms of transition in 12 ticks, the pointer still, and the rest of the ticks after it.
      for (let index = 0; index < 24; index++) {
        tick(renderer, index % 2 === 0 ? 1 : 2)
        pictures.push(picture(renderer))
      }
      renderer.dispatchNativeEvents()
      return { pictures, ends, counters: scroll(renderer) }
    } finally {
      unmount()
    }
  }

  it("keeps a transition running: the same pictures and its end, the translate on or off", () => {
    const on = transition(true)
    const off = transition(false)
    expect(off.ends).toEqual(["end"])
    expect(on.ends).toEqual(["end"])
    expect(on.pictures).toEqual(off.pictures)
  })

  unverified("draws whole the frames of a scroll while the transition runs, and translates again after its end", () => {
    const on = transition(true)
    expect(on.counters.reasons.Clock).toBeGreaterThan(5)
    expect(on.counters.mispredicted).toBe(0)
    // The last ticks, 12 of them after the end, are translates.
    expect(on.counters.patched).toBeGreaterThan(5)
  })

  /** The blink of the caret of an input beside the list, due in the draw of a wheel event. */
  function blink(translate: boolean) {
    const { renderer, unmount } = open(translate, true)
    try {
      renderer.focusElement(renderer.findByTestId("field").id)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      tick(renderer, 4)
      tick(renderer, -4)
      const pictures: string[] = []
      // Half a second a step: the caret changes phase in each.
      for (let index = 0; index < 8; index++) {
        tick(renderer, index % 2 === 0 ? 1 : 2, 500)
        pictures.push(picture(renderer))
      }
      return { pictures, counters: scroll(renderer) }
    } finally {
      unmount()
    }
  }

  it("blinks a caret beside the list as the build does", () => {
    const on = blink(true)
    const off = blink(false)
    expect(new Set(off.pictures).size, "the caret changes phase").toBeGreaterThan(1)
    expect(on.pictures).toEqual(off.pictures)
  })
})
