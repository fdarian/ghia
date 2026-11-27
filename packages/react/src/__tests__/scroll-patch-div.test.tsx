// @ts-nocheck
/**
 * The frames drawn after a wheel over a `div` scroller (`overflow: auto`) that are a pure move of what its roots recorded are drawn
 * as one, as the frames of a `<virtual-list>` are (`scroll-patch-translate.test.tsx`): the operations and hitboxes of each root are
 * made again from its recording at the new offset, what the roots wrote into the registries is moved, the boxes the build wrote
 * for what is between the scroller and the roots are moved, and nothing is built (`getPatchCounters().scrollPatch.patched`). The
 * picture, the boxes, what is under a point, the cursor, the clicks, the `scroll` event and `scrollTop` are what they are with the
 * translate off (`setScrollPatchEnabled(false)`).
 *
 * The rows are what TanStack Virtual writes: absolute boxes in a box of the height of all of them, in a scroller. Rows of 40 in a
 * view of 100, narrower than the scroller so that a pointer in the gutter takes no row (a hover under a wheel is not a translate yet).
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its rows
// are built, not replayed, so there is nothing to translate after it. The first translate after a frame that is not verified is, and
// the verifier compares it with the frame built whole (the cases that count translates skip there).
const unverified = it.skipIf(verifying)

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const ROW_WIDTH = 150
const TIMEOUT = 120_000
const VSYNC = 16

type Log = { scrolls: number[][]; clicks: number[] }

function Page({ log, layout, bar }: { log: Log; layout: "absolute" | "flow"; bar: boolean }) {
  const rows = Array.from({ length: COUNT }, (_, index) => (
    <div
      key={index}
      testId={`row-${index}`}
      onClick={() => log.clicks.push(index)}
      style={{
        position: layout === "absolute" ? "absolute" : undefined,
        top: layout === "absolute" ? index * ROW : undefined,
        width: ROW_WIDTH,
        height: ROW,
        flexShrink: 0,
        backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
      }}
    >
      <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
    </div>
  ))
  return (
    <div
      testId="scroller"
      onScroll={(event) => log.scrolls.push([event.scrollLeft, event.scrollTop])}
      style={{ width: 200, height: VIEWPORT, overflowY: "auto", scrollbarWidth: bar ? undefined : "none" }}
    >
      {layout === "absolute" ? (
        <div testId="inner" style={{ position: "relative", width: "100%", height: COUNT * ROW }}>
          {rows}
        </div>
      ) : (
        rows
      )}
    </div>
  )
}

function open(translate: boolean, layout: "absolute" | "flow", bar = false) {
  const log: Log = { scrolls: [], clicks: [] }
  const root = createTestRoot({ width: 300, height: 200 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(<Page log={log} layout={layout} bar={bar} />)
  for (let frame = 0; frame < 3; frame++) {
    renderer.flush()
    renderer.dispatchNativeEvents()
  }
  renderer.setA11yActive(false)
  renderer.setInlineDraws(false)
  renderer.drawFrame()
  renderer.drawFrame()
  renderer.setScrollPatchEnabled(translate)
  return { ...root, renderer, log }
}

/** A display-link tick `ms` later with a wheel event of `by` in it, and the frame it draws. */
function tick(renderer, by: number, x = 180, ms = VSYNC) {
  renderer.clockAdvance(ms)
  renderer.advanceTime(ms)
  renderer.nativeSimulateScrollWheel(x, 60, 0, by)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

let shots = 0
/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer): string {
  const file = `${SHOTS_DIR}/scroll-patch-div-${process.pid}-${shots++}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const element of renderer.findByType("div")) {
    const box = renderer.getElementBounds(element.id)
    if (box) out[String(element.id)] = box
  }
  return out
}

const scroll = (renderer) => renderer.getPatchCounters().scrollPatch

/** What a test observes of the page after a step. */
function seen(renderer, points: Array<[number, number]>) {
  const scroller = renderer.findByTestId("scroller")
  return {
    boxes: boxes(renderer),
    scrollOffset: renderer.getScrollOffset(scroller.id),
    under: points.map(([x, y]) => renderer.getElementsAt(x, y)),
    cursor: renderer.getCursor(),
    picture: picture(renderer),
  }
}

/** The steps run on a page with the translate on or off; each is seen after. */
function run(translate: boolean, layout: "absolute" | "flow", steps: number[], points: Array<[number, number]>, bar = false) {
  const { renderer, unmount, log } = open(translate, layout, bar)
  try {
    // A wheel and its way back record the rows, put them elsewhere and show the bar.
    tick(renderer, 4)
    tick(renderer, -4)
    log.scrolls.length = 0
    const warmed = scroll(renderer).patched
    const frames: unknown[] = []
    const translated: boolean[] = []
    for (const step of steps) {
      const before = scroll(renderer).patched
      tick(renderer, step)
      translated.push(scroll(renderer).patched > before)
      frames.push(seen(renderer, points))
    }
    return { frames, translated, counters: scroll(renderer), warmed, log }
  } finally {
    unmount()
  }
}

describeNative("the content of a div scroller moved by a wheel", { timeout: TIMEOUT }, () => {
  // The pointer at x = 180 is in the gutter of the scroller, beside the rows (150 wide): it takes no hover.
  const wheels = [3, 5, 8, -4, -9, 6, 2, 7]
  const points: Array<[number, number]> = [[20, 10], [20, 50], [180, 60], [100, 99]]

  for (const layout of ["absolute", "flow"] as const) {
    unverified(`draws every wheel step over rows in ${layout === "absolute" ? "a box that holds them" : "the flow"} as a translate, the same as the build`, () => {
      const on = run(true, layout, wheels, points)
      const off = run(false, layout, wheels, points)
      expect(off.counters.frames).toBe(0)
      expect(on.counters.mispredicted).toBe(0)
      expect(on.translated, "every step is a translate").toEqual(wheels.map(() => true))
      expect(on.counters.patched - on.warmed).toBe(wheels.length)
      expect(off.translated.some(Boolean)).toBe(false)
      expect(on.counters.eligible).toBe(on.counters.patched + Object.values(on.counters.applyDeclines).reduce((a, b) => a + b, 0))
      // The picture, the boxes (the rows and the box that holds them), what is under the points, the cursor and the offset.
      expect(on.frames).toEqual(off.frames)
      // The `scroll` event of every step has the offset the step left, a translated step as a built one.
      expect(on.log.scrolls).toEqual(off.log.scrolls)
      expect(on.log.scrolls.length).toBe(wheels.length)
      expect(on.log.scrolls.at(-1)).toEqual(on.frames.at(-1).scrollOffset)
    })
  }

  it("draws the same picture, boxes and hits under the verifier, and the verifier finds no difference", () => {
    const on = run(true, "absolute", wheels, points)
    const off = run(false, "absolute", wheels, points)
    expect(on.frames).toEqual(off.frames)
    expect(on.log.scrolls).toEqual(off.log.scrolls)
    if (verifying) {
      const { renderer, unmount } = open(true, "absolute")
      try {
        tick(renderer, 4)
        tick(renderer, -4)
        for (const step of wheels) tick(renderer, step)
        expect(renderer.getRetainedCounters().mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
      } finally {
        unmount()
      }
    }
  })

  unverified("clicks the row under the pointer, read from the hitboxes the translate moved", () => {
    const clicked = (translate: boolean) => {
      const { renderer, unmount, log } = open(translate, "absolute")
      try {
        tick(renderer, 4)
        tick(renderer, -4)
        const rows: number[] = []
        for (const step of [13, 9, 30]) {
          tick(renderer, step)
          const before = log.clicks.length
          renderer.nativeSimulateClick(20, 50)
          rows.push(...log.clicks.slice(before))
        }
        return { rows, patched: scroll(renderer).patched }
      } finally {
        unmount()
      }
    }
    const on = clicked(true)
    const off = clicked(false)
    expect(off.patched).toBe(0)
    expect(on.patched).toBeGreaterThan(0)
    expect(on.rows).toEqual(off.rows)
    expect(on.rows.length).toBe(3)
  })

  unverified("reads the box of a row and of the box that holds the rows, and scrollTop, after a translate, without drawing", () => {
    const { renderer, unmount, log } = open(true, "absolute")
    try {
      tick(renderer, 4)
      tick(renderer, -4)
      tick(renderer, 13)
      expect(scroll(renderer).patched).toBeGreaterThan(0)
      const painted = renderer.getPaintedFrameCount()
      const scroller = renderer.findByTestId("scroller")
      const row = renderer.findByTestId("row-1")
      const inner = renderer.findByTestId("inner")
      expect(renderer.getScrollOffset(scroller.id)).toEqual([0, 13])
      // Row 1 is at 40 in the content, 13 above where it is without the scroll; the box that holds the rows at 0, 13 above.
      expect(renderer.getElementBounds(row.id).y).toBeCloseTo(40 - 13, 3)
      expect(renderer.getElementBounds(inner.id).y).toBeCloseTo(-13, 3)
      expect(renderer.getPaintedFrameCount(), "the reads built nothing").toBe(painted)
      expect(log.scrolls.at(-1)).toEqual([0, 13])
    } finally {
      unmount()
    }
  })

  unverified("draws the same picture with the scrollbar the system draws, and moves its thumb in the frame", () => {
    const steps = [3, 5, 8, -4, -9, 6, 2, 7]
    const on = run(true, "absolute", steps, points, true)
    const off = run(false, "absolute", steps, points, true)
    expect(on.frames).toEqual(off.frames)
    expect(on.counters.mispredicted).toBe(0)
    // The bar was shown by the wheel before: every step moves the thumb in place.
    expect(on.translated, "every step is a translate").toEqual(steps.map(() => true))
    // The first wheel of the warm-up shows the bar (`Thumb.appear`); no step after it misses.
    const thumbMisses = Object.entries(on.counters.held).filter(([name, count]) => name.startsWith("Thumb") && name !== "Thumb" && name !== "Thumb.appear" && count > 0)
    expect(thumbMisses).toEqual([])
    expect(on.counters.held["Thumb.appear"]).toBeLessThanOrEqual(1)
  })

  it("builds the frame whole when a root that culling left out would come into reach, never an empty one", () => {
    // Rows in the flow are left out of the frame far from the view; a scroll that brings one within the overscan builds it.
    const steps = Array.from({ length: 30 }, () => 40)
    const on = run(true, "flow", steps, points)
    const off = run(false, "flow", steps, points)
    expect(on.frames).toEqual(off.frames)
    expect(on.counters.mispredicted).toBe(0)
    expect(on.counters.held["NotRelocatable.entered"], "a culled row came into reach").toBeGreaterThan(0)
    if (!verifying) expect(on.counters.patched).toBeGreaterThan(0)
  })

  it("is a whole frame while the accessibility tree is built, and the same picture", () => {
    const frame = (translate: boolean) => {
      const { renderer, unmount } = open(translate, "absolute")
      try {
        renderer.setA11yActive(true)
        renderer.drawFrame()
        tick(renderer, 4)
        tick(renderer, 9)
        return { counters: scroll(renderer), picture: picture(renderer) }
      } finally {
        unmount()
      }
    }
    const on = frame(true)
    const off = frame(false)
    expect(on.counters.patched).toBe(0)
    expect(on.counters.held.A11y).toBeGreaterThan(0)
    expect(on.picture).toEqual(off.picture)
  })
})
