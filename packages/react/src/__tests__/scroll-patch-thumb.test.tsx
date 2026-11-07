// @ts-nocheck
/**
 * The thumb of the overlay scrollbar of a list in the frames a scroll draws by moving the rows of the frame shown
 * (`scroll-patch-translate.test.tsx`): it is moved with them, so a list with the scrollbar the system draws is translated as
 * well, and the picture is the one the build makes. What a frame cannot move the thumb to is a `Thumb`, drawn whole: the bar
 * that is not on screen and would be, and the one in a step of its fade.
 *
 * Time moves as a display link would move it: a vsync moves the clock of the window and the executor's together, then the
 * wheel events of the tick arrive and the frame is drawn.
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

function Page({ count = COUNT }: { count?: number }) {
  return (
    <virtual-list
      testId="list"
      itemCount={count}
      estimatedItemHeight={ROW}
      overdraw={0}
      style={{ width: 200, height: VIEWPORT, backgroundColor: "#808080" }}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} testId={`row-${index}`} style={{ width: 150, height: ROW, flexShrink: 0, backgroundColor: index % 2 === 0 ? "#223344" : "#334455" }}>
          <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
        </div>
      ))}
    </virtual-list>
  )
}

function open(translate: boolean, count = COUNT) {
  const root = createTestRoot({ width: 300, height: 200 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(<Page count={count} />)
  for (let frame = 0; frame < 3; frame++) {
    renderer.flush()
    renderer.dispatchNativeEvents()
  }
  renderer.setA11yActive(false)
  renderer.setInlineDraws(false)
  renderer.drawFrame()
  renderer.drawFrame()
  renderer.setScrollPatchEnabled(translate)
  return { ...root, renderer }
}

/** A display-link tick `ms` later with a wheel event of `by` in it, if any, and the frame it draws. */
function tick(renderer, by: number | undefined, ms = VSYNC) {
  renderer.clockAdvance(ms)
  renderer.advanceTime(ms)
  if (by !== undefined) renderer.nativeSimulateScrollWheel(180, 60, 0, by)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

let shots = 0
function picture(renderer): string {
  const file = `${SHOTS_DIR}/scroll-patch-thumb-${process.pid}-${shots++}.png`
  fs.rmSync(file, { force: true })
  renderer.captureScreenshot(file)
  // The capture notifies the view: the frame it asks for is its own and not the next tick's.
  renderer.drawFrame()
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function scroll(renderer) {
  return renderer.getPatchCounters().scrollPatch
}

/** The picture after each tick of `ticks` (a wheel delta, or a wait of that many ticks with none), the translate on or off. */
function run(translate: boolean, ticks: Array<number | { wait: number }>, count = COUNT) {
  const { renderer, unmount } = open(translate, count)
  try {
    // A wheel and its way back record the rows and show the bar.
    tick(renderer, 4)
    tick(renderer, -4)
    const warmed = scroll(renderer)
    const pictures: string[] = []
    for (const step of ticks) {
      if (typeof step === "number") tick(renderer, step)
      else for (let index = 0; index < step.wait; index++) tick(renderer, undefined)
      pictures.push(picture(renderer))
    }
    if (verifying) {
      expect(renderer.getRetainedCounters().mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
    }
    return { pictures, counters: scroll(renderer), warmed }
  } finally {
    unmount()
  }
}

describeNative("the thumb of a list in the frames a scroll draws by moving the rows", { timeout: TIMEOUT }, () => {
  const steps = [3, 5, 8, -4, -9, 6, 2, 7]

  unverified("is moved with the rows, and the picture is the build's", () => {
    const on = run(true, steps)
    const off = run(false, steps)
    expect(off.counters.frames).toBe(0)
    expect(on.counters.mispredicted).toBe(0)
    expect(on.counters.patched).toBeGreaterThan(0)
    expect(on.counters.held.Thumb).toBe(on.warmed.held.Thumb)
    expect(on.pictures).toEqual(off.pictures)
  })

  it("is where the build puts it also under the verifier", () => {
    expect(run(true, steps).pictures).toEqual(run(false, steps).pictures)
  })

  it("is moved back where the whole frame painted it when a scroll brings the rows back there", () => {
    // Six rows of 40 in a view of 100: the thumb is long and travels 0.4 px for each of the 20 px that the first three rows allow
    // before a fourth is needed, so it is on another pixel at 20 than at 0. The bar fades and the scroll that shows it again is
    // drawn whole, at 20; the next two put the rows at 0 and back at 20, where that frame painted the thumb.
    const back: Array<number | { wait: number }> = [{ wait: 90 }, 20, -20, 20, -20, 15, -15, 20]
    const on = run(true, back, 6)
    const off = run(false, back, 6)
    expect(on.pictures).toEqual(off.pictures)
    expect(new Set(off.pictures).size, "the thumb is on more than one pixel").toBeGreaterThan(2)
    if (!verifying) {
      expect(on.counters.patched - on.warmed.patched).toBeGreaterThanOrEqual(5)
    }
  })

  unverified("holds for a second after the last of the translated frames, and fades after it", () => {
    // 70 ticks of a pixel are 1.1 s with the bar held by the scroll all through: it does not fade while the frames that moved
    // the rows did not build it. Then the second of the hold after the last, and the fade.
    const scrolling: Array<number | { wait: number }> = Array.from({ length: 70 }, () => 1)
    const after: Array<number | { wait: number }> = [{ wait: 30 }, { wait: 31 }, { wait: 1 }, { wait: 5 }, { wait: 10 }]
    const on = run(true, [...scrolling, ...after])
    const off = run(false, [...scrolling, ...after])
    expect(on.counters.patched).toBeGreaterThan(30)
    expect(on.counters.mispredicted).toBe(0)
    expect(on.pictures).toEqual(off.pictures)
  })

  unverified("is a decline when the bar has faded and the scroll would show it: that frame is drawn whole", () => {
    const { renderer, unmount } = open(true)
    try {
      tick(renderer, 4)
      tick(renderer, -4)
      tick(renderer, 5)
      const patched = scroll(renderer).patched
      expect(patched).toBeGreaterThan(0)
      // The hold and the fade are over.
      for (let index = 0; index < 90; index++) tick(renderer, undefined)
      const before = scroll(renderer)
      tick(renderer, 5)
      const now = scroll(renderer)
      expect(now.frames - before.frames).toBe(1)
      expect(now.patched).toBe(before.patched)
      expect(now.reasons.Thumb - (before.reasons.Thumb ?? 0)).toBe(1)
      expect(now.held["Thumb.appear"] - (before.held["Thumb.appear"] ?? 0)).toBe(1)
      // The next one finds the bar on screen again.
      tick(renderer, 5)
      expect(scroll(renderer).patched).toBe(patched + 1)
    } finally {
      unmount()
    }
  })

  it("draws a bar that is in a step of its fade whole, and the picture is the build's", () => {
    const fading: Array<number | { wait: number }> = [{ wait: 62 }, 5, { wait: 3 }, 5, { wait: 5 }, 5]
    const on = run(true, fading)
    const off = run(false, fading)
    expect(on.pictures).toEqual(off.pictures)
  })
})
