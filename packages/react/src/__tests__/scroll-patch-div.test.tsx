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

/** `transform`: TanStack Virtual's rows, absolute at the top of the box that holds them and moved by a `translateY`. */
type Layout = "absolute" | "flow" | "transform"

type Log = { scrolls: number[][]; clicks: number[]; hovers: string[]; inners: Record<number, { scrollTop: number }>; onScroll?: () => void }

/**
 * `hover`: each row takes another background under the pointer. `count`: how many rows the page has. `rich`: rows as the mailbox of
 * ghia-bench makes them, with positioned boxes in each (an avatar, a column of two lines that an ellipsis cuts): what a row hands to the
 * stacking context of its own is not painted where its parent's children are.
 */
type Options = { hover?: boolean; count?: number; rich?: boolean; events?: boolean; inner?: boolean; tint?: boolean; salt?: number }

function Page({ log, layout, bar, hover, rich, events, inner, tint, salt = 0, count = COUNT }: { log: Log; layout: Layout; bar: boolean } & Options) {
  const rows = Array.from({ length: count }, (_, index) => (
    <div
      key={index}
      testId={`row-${index}`}
      onClick={() => log.clicks.push(index)}
      onPointerEnter={events ? () => log.hovers.push(`enter ${index}`) : undefined}
      onPointerLeave={events ? () => log.hovers.push(`leave ${index}`) : undefined}
      style={{
        position: layout === "flow" ? undefined : "absolute",
        top: layout === "absolute" ? index * ROW : layout === "transform" ? 0 : undefined,
        ...(layout === "transform" ? { transform: `translateY(${index * ROW}px)` } : {}),
        width: ROW_WIDTH,
        height: ROW,
        flexShrink: 0,
        ...(rich ? { borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "#445566", userSelect: "none" } : {}),
        backgroundColor: (index + salt) % 2 === 0 ? "#223344" : "#334455",
        ...(hover ? { hover: { backgroundColor: "#664422" } } : {}),
      }}
    >
      {inner ? (
        <div
          ref={(instance) => {
            if (instance !== null) log.inners[index] = instance
          }}
          testId={`inner-${index}`}
          style={{ position: "absolute", left: 90, top: 4, width: 40, height: 30, overflowY: "auto" }}
        >
          {["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff"].map((color) => (
            <div key={color} style={{ height: 30, flexShrink: 0, backgroundColor: color }} />
          ))}
        </div>
      ) : null}
      {rich ? (
        <>
          <div style={{ position: "absolute", left: 4, top: 4, width: 12, height: 12, borderRadius: 6, backgroundColor: "#2563eb" }} />
          <div style={{ position: "absolute", left: 130, top: 8, width: 16, height: 16, borderRadius: 8, backgroundColor: "#7c3aed", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ color: "#ffffff", fontSize: 9 }}>AB</div>
          </div>
          <div style={{ position: "absolute", left: 20, top: 2, right: 4, display: "flex", flexDirection: "column" }}>
            <div style={{ color: "#ffffff", height: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{`row-${index} a sender with a long name`}</div>
            <div style={{ color: "#aaaaaa", height: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{`the subject of row ${index}, which is long`}</div>
          </div>
        </>
      ) : (
        <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
      )}
    </div>
  ))
  return (
    <div
      testId="scroller"
      onScroll={(event) => {
        log.scrolls.push([event.scrollLeft, event.scrollTop])
        log.onScroll?.()
      }}
      style={{ width: 200, height: VIEWPORT, overflowY: "auto", scrollbarWidth: bar ? undefined : "none", ...(tint ? { backgroundColor: "#101820" } : {}) }}
    >
      {layout !== "flow" ? (
        <div testId="inner" style={{ position: "relative", width: "100%", height: count * ROW }}>
          {rows}
        </div>
      ) : (
        rows
      )}
    </div>
  )
}

function open(translate: boolean, layout: Layout, bar = false, options: Options = {}) {
  const log: Log = { scrolls: [], clicks: [], hovers: [], inners: {} }
  const root = createTestRoot({ width: 300, height: 200 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(<Page log={log} layout={layout} bar={bar} {...options} />)
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
function run(translate: boolean, layout: Layout, steps: number[], points: Array<[number, number]>, bar = false) {
  const opened = open(translate, layout, bar)
  const renderer = opened.renderer
  try {
    // A wheel and its way back record the rows, put them elsewhere and show the bar.
    tick(renderer, 4)
    tick(renderer, -4)
    opened.log.scrolls.length = 0
    const warmed = scroll(renderer).patched
    const frames: unknown[] = []
    const translated: boolean[] = []
    for (const step of steps) {
      const before = scroll(renderer).patched
      tick(renderer, step)
      translated.push(scroll(renderer).patched > before)
      frames.push(seen(renderer, points))
    }
    return { frames, translated, counters: scroll(renderer), warmed, log: opened.log }
  } finally {
    opened.unmount()
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
      const opened = open(true, "absolute")
      const renderer = opened.renderer
      try {
        tick(renderer, 4)
        tick(renderer, -4)
        for (const step of wheels) tick(renderer, step)
        expect(renderer.getRetainedCounters().mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
      } finally {
        opened.unmount()
      }
    }
  })

  unverified("clicks the row under the pointer, read from the hitboxes the translate moved", () => {
    const clicked = (translate: boolean) => {
      const opened = open(translate, "absolute")
      const renderer = opened.renderer
      try {
        tick(renderer, 4)
        tick(renderer, -4)
        const rows: number[] = []
        for (const step of [13, 9, 30]) {
          tick(renderer, step)
          const before = opened.log.clicks.length
          renderer.nativeSimulateClick(20, 50)
          rows.push(...opened.log.clicks.slice(before))
        }
        return { rows, patched: scroll(renderer).patched }
      } finally {
        opened.unmount()
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
    const opened = open(true, "absolute")
    const renderer = opened.renderer
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
      expect(opened.log.scrolls.at(-1)).toEqual([0, 13])
    } finally {
      opened.unmount()
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
      const opened = open(translate, "absolute")
      const renderer = opened.renderer
      try {
        renderer.setA11yActive(true)
        renderer.drawFrame()
        tick(renderer, 4)
        tick(renderer, 9)
        return { counters: scroll(renderer), picture: picture(renderer) }
      } finally {
        opened.unmount()
      }
    }
    const on = frame(true)
    const off = frame(false)
    expect(on.counters.patched).toBe(0)
    expect(on.counters.held.A11y).toBeGreaterThan(0)
    expect(on.picture).toEqual(off.picture)
  })

  // The pointer is over the rows, which take a hover colour; each wheel step carries it over another row border or stays in the row,
  // and the scroll ends on another row than the one it began on.
  const crossing = [15, 15, -5, 15, 15, 15, 5]
  const pointer = [20, 60] as const
  const hits: Array<[number, number]> = [[20, 10], [20, 50], [pointer[0], pointer[1]], [100, 99]]

  const sourced = (renderer) => JSON.parse(renderer.getPatchCounters().unpatchable).Sourced ?? 0

  /** The page after each wheel step under a pointer that stays, and after the scroll has ended and the hover has followed. */
  function underStill(translate: boolean, layout: Layout) {
    const opened = open(translate, layout, false, { hover: true, rich: layout === "transform" })
    const renderer = opened.renderer
    try {
      renderer.nativeSimulateMouseMove(...pointer)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      renderer.drawFrame()
      tick(renderer, 4, pointer[0])
      tick(renderer, -4, pointer[0])
      opened.log.scrolls.length = 0
      const translated: boolean[] = []
      const frames: unknown[] = []
      for (const step of crossing) {
        const patched = scroll(renderer).patched
        tick(renderer, step, pointer[0])
        translated.push(scroll(renderer).patched > patched)
        frames.push(seen(renderer, hits))
      }
      const during = scroll(renderer)
      renderer.advanceTime(500)
      renderer.dispatchNativeEvents()
      for (let frame = 0; frame < 3; frame++) renderer.drawFrame()
      return { translated, frames, during, ended: seen(renderer, hits), log: opened.log }
    } finally {
      opened.unmount()
    }
  }

  for (const layout of ["absolute", "transform"] as const) {
    unverified(`moves ${layout} rows under a pointer that stays by translates, and follows the hover when the scroll ends`, () => {
      const on = underStill(true, layout)
      const off = underStill(false, layout)
      expect(on.translated, "every step is a translate, the steps that cross a row border included").toEqual(crossing.map(() => true))
      expect(on.during.held.Hover ?? 0, "a pointer that did not move holds nothing").toBe(0)
      expect(on.during.mispredicted).toBe(0)
      // The picture, the boxes and what is under the points are those of the frames built whole, while the wheel goes on and when it ends.
      expect(on.frames).toEqual(off.frames)
      expect(on.ended).toEqual(off.ended)
      expect(on.ended.picture, "the hover moved to the row now under the pointer").not.toEqual(on.frames.at(-1).picture)
      expect(on.log.scrolls).toEqual(off.log.scrolls)
    })
  }

  /** Wheel steps with no frame asking the page for anything else, then the end of the scroll: the frames the end draws. */
  function endOfScroll(translate: boolean, layout: Layout) {
    const opened = open(translate, layout, false, { hover: true })
    const renderer = opened.renderer
    try {
      renderer.nativeSimulateMouseMove(...pointer)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      renderer.drawFrame()
      tick(renderer, 4, pointer[0])
      tick(renderer, -4, pointer[0])
      for (const step of crossing) tick(renderer, step, pointer[0])
      const patched = renderer.getPatchCounters().patchedFrames
      const painted = renderer.getPaintedFrameCount()
      renderer.advanceTime(500)
      renderer.dispatchNativeEvents()
      for (let frame = 0; frame < 3; frame++) renderer.drawFrame()
      return {
        patched: renderer.getPatchCounters().patchedFrames - patched,
        whole: renderer.getPaintedFrameCount() - painted,
        picture: picture(renderer),
      }
    } finally {
      opened.unmount()
    }
  }

  unverified("follows the hover at the end of a scroll over rows in the flow by a patch of the two rows, not a frame built whole", () => {
    const on = endOfScroll(true, "flow")
    const off = endOfScroll(false, "flow")
    expect(on.whole).toBe(0)
    expect(on.patched).toBeGreaterThanOrEqual(1)
    expect(on.picture).toEqual(off.picture)
  })

  /**
   * Each wheel step has a commit with it, as TanStack Virtual's scroll handler makes one for the rows the offset needs. The commit is
   * part of the scroll: the hover (and the `pointerenter` and `pointerleave` of the rows) follows when the wheel is quiet.
   */
  function commitsUnderStill(translate: boolean, layout: Layout) {
    const opened = open(translate, layout, false, { hover: true, events: true, count: 20 })
    const renderer = opened.renderer
    try {
      renderer.nativeSimulateMouseMove(...pointer)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      renderer.drawFrame()
      tick(renderer, 4, pointer[0])
      tick(renderer, -4, pointer[0])
      opened.log.hovers.length = 0
      let count = 20
      for (const step of [15, 15, 15, 15, 15]) {
        renderer.clockAdvance(VSYNC)
        renderer.advanceTime(VSYNC)
        renderer.nativeSimulateScrollWheel(pointer[0], pointer[1], 0, step)
        renderer.dispatchNativeEvents()
        count += 1
        opened.render(<Page log={opened.log} layout={layout} bar={false} count={count} hover events />)
        renderer.drawFrame()
      }
      const during = { hovers: [...opened.log.hovers], picture: picture(renderer) }
      renderer.advanceTime(500)
      for (let frame = 0; frame < 3; frame++) {
        renderer.dispatchNativeEvents()
        renderer.drawFrame()
      }
      renderer.dispatchNativeEvents()
      return { during, hovers: [...opened.log.hovers], picture: picture(renderer), boxes: boxes(renderer), under: renderer.getElementsAt(...pointer) }
    } finally {
      opened.unmount()
    }
  }

  for (const layout of ["absolute", "flow"] as const) {
    unverified(`holds the hover over the commits of a scroll over ${layout} rows and follows when the wheel is quiet`, () => {
      const on = commitsUnderStill(true, layout)
      const off = commitsUnderStill(false, layout)
      expect(on.during.hovers, "the commits leave the hover where the pointer put it").toEqual([])
      expect(on.hovers, "the boundary events fire once, from the row the pointer was on to the one under it").toEqual(["leave 1", "enter 3"])
      expect(off.hovers).toEqual(on.hovers)
      expect(on.during.picture).toEqual(off.during.picture)
      expect(on.picture, "the hover colour moved to the row under the pointer").not.toEqual(on.during.picture)
      expect(on.picture).toEqual(off.picture)
      expect(on.boxes).toEqual(off.boxes)
      expect(on.under).toEqual(off.under)
    })
  }

  it.runIf(verifying)("follows the hover as the build does under the verifier, after commits", () => {
    for (const layout of ["absolute", "flow"] as const) {
      const on = commitsUnderStill(true, layout)
      expect(on.hovers).toEqual(["leave 1", "enter 3"])
    }
  })

  unverified("does not decline the tick after translates for the scroll they made", () => {
    const opened = open(true, "absolute", false, { hover: true })
    const renderer = opened.renderer
    try {
      renderer.nativeSimulateMouseMove(...pointer)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      renderer.drawFrame()
      tick(renderer, 4, pointer[0])
      tick(renderer, -4, pointer[0])
      for (const step of [15, 15, 15]) tick(renderer, step, pointer[0])
      expect(scroll(renderer).patched).toBeGreaterThanOrEqual(3)
      const declined = sourced(renderer)
      // The pointer moves to another row: a tick, drawn after frames that moved the content without building it. The frame shown has
      // the scroller where those left it, so the scroll is not a source of the tick.
      renderer.nativeSimulateMouseMove(20, 20)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      expect(sourced(renderer) - declined).toBe(0)
    } finally {
      opened.unmount()
    }
  })

  it.runIf(verifying)("draws the rows under a pointer that stays as the build does, under the verifier", () => {
    for (const layout of ["absolute", "transform"] as const) {
      const opened = open(true, layout, false, { hover: true, rich: layout === "transform" })
      const renderer = opened.renderer
      try {
        renderer.nativeSimulateMouseMove(...pointer)
        renderer.dispatchNativeEvents()
        renderer.drawFrame()
        tick(renderer, 4, pointer[0])
        tick(renderer, -4, pointer[0])
        for (const step of crossing) tick(renderer, step, pointer[0])
        renderer.advanceTime(500)
        renderer.dispatchNativeEvents()
        for (let frame = 0; frame < 3; frame++) renderer.drawFrame()
        expect(renderer.getRetainedCounters().mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
      } finally {
        opened.unmount()
      }
    }
  })

  /**
   * A wheel step that has a row come into the scroller in the same frame, as TanStack Virtual's commit makes one (its scroll handler
   * renders the row the new offset needs), then wheel steps of their own: the frame after the row came in is the frame shown, and the
   * next step moves it.
   */
  function appended(translate: boolean, layout: Layout) {
    const opened = open(translate, layout, false, { count: 5, rich: true })
    const renderer = opened.renderer
    try {
      tick(renderer, 4)
      tick(renderer, -4)
      const translated: boolean[] = []
      const frames: unknown[] = []
      let count = 5
      for (const [index, step] of [3, 5, 8, -4, 9, 7].entries()) {
        const before = scroll(renderer).patched
        if (index === 0 || index === 3) {
          renderer.clockAdvance(VSYNC)
          renderer.advanceTime(VSYNC)
          renderer.nativeSimulateScrollWheel(180, 60, 0, step)
          renderer.dispatchNativeEvents()
          count += 1
          opened.render(<Page log={opened.log} layout={layout} bar={false} count={count} rich />)
          renderer.drawFrame()
        } else {
          tick(renderer, step)
          translated.push(scroll(renderer).patched > before)
        }
        frames.push(seen(renderer, [[20, 10], [20, 50], [100, 99]]))
      }
      return { translated, frames, counters: scroll(renderer), log: opened.log }
    } finally {
      opened.unmount()
    }
  }

  // The rows are the mailbox's: each is a stacking context of its own (a transform) that its positioned boxes are handed to.
  unverified("moves rows by translates from the tick after a row came into the scroller", () => {
    const on = appended(true, "transform")
    const off = appended(false, "transform")
    expect(on.counters.held["NotRelocatable.unrooted"], "what a row built in the frame hands to its own context is the row's").toBe(0)
    expect(on.translated, "every step that brings no row is a translate").toEqual([true, true, true, true])
    expect(on.counters.mispredicted).toBe(0)
    expect(on.frames).toEqual(off.frames)
    expect(on.log.scrolls).toEqual(off.log.scrolls)
  })

  it.runIf(verifying)("draws the same after a row came into the scroller under the verifier", () => {
    const on = appended(true, "transform")
    const off = appended(false, "transform")
    expect(on.frames).toEqual(off.frames)
  })

  /**
   * A page that keeps two scrollers in step moves one from the `scroll` event of the other, with no commit: the `scrollTop` it writes
   * is instant. When the frame shown built the rows (a commit did) the scroller inside a row is recorded with it, and the frame knows it
   * as no scroller: a translate of the outer one would leave it where that frame had it (and hide it from the frame built whole after).
   * Such a wheel step is a frame built whole. Ghia prepaints the scroller of a replayed row outside its recording, so the frame shown does know it
   * (it holds the outer scroller as `NotRelocatable.nested`) and no step here is a translate; the case the gate answers for, a scroller gpui does not
   * know, is pinned by `retain.rs` and zed's `scroll_patch_div_tests.rs`. What is pinned here is what the page shows.
   */
  function steppedInner(translate: boolean, move: "event" | "before" | "none") {
    const opened = open(translate, "absolute", false, { inner: true })
    const renderer = opened.renderer
    try {
      tick(renderer, 4)
      tick(renderer, -4)
      opened.render(<Page log={opened.log} layout="absolute" bar={false} inner salt={1} />)
      renderer.drawFrame()
      let top = 0
      if (move === "event") opened.log.onScroll = () => void (opened.log.inners[1].scrollTop = top += 9)
      const innerOffset = () => renderer.getScrollOffset(renderer.findByTestId("inner-1").id)
      const translated: boolean[] = []
      const frames: unknown[] = []
      for (const step of [3, 5, 8, -2, 6]) {
        if (move === "before") opened.log.inners[1].scrollTop = top += 9
        const patched = scroll(renderer).patched
        tick(renderer, step)
        translated.push(scroll(renderer).patched > patched)
        // The event of the step is delivered after its frame, and the next wheel finds the inner scroller moved.
        renderer.dispatchNativeEvents()
        frames.push({ ...seen(renderer, points), inner: innerOffset() })
      }
      renderer.drawFrame()
      const settled = { ...seen(renderer, points), inner: innerOffset() }
      // A commit that changes nothing of the rows draws a frame built whole: the inner scroller is where the script put it.
      opened.render(<Page log={opened.log} layout="absolute" bar={false} inner salt={1} tint />)
      renderer.drawFrame()
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      const whole = { ...seen(renderer, points), inner: innerOffset() }
      return { translated, frames, settled, whole, counters: scroll(renderer), top }
    } finally {
      opened.unmount()
    }
  }

  for (const move of ["event", "before"] as const) {
    it(`draws a wheel step whole when script moved a scroller inside a row (${move}), and the frame after it right`, () => {
      const on = steppedInner(true, move)
      const off = steppedInner(false, move)
      expect(on.top).toBeGreaterThan(0)
      expect(on.frames).toEqual(off.frames)
      expect(on.settled).toEqual(off.settled)
      expect(on.whole).toEqual(off.whole)
      expect(on.whole.inner, "the inner scroller is where the script put it").toEqual([0, on.top])
      expect(on.counters.mispredicted).toBe(0)
    })
  }

  it.runIf(verifying)("draws the same as the build after script moved a scroller inside a row, under the verifier", () => {
    const opened = open(true, "absolute", false, { inner: true })
    const renderer = opened.renderer
    try {
      tick(renderer, 4)
      tick(renderer, -4)
      opened.render(<Page log={opened.log} layout="absolute" bar={false} inner salt={1} />)
      renderer.drawFrame()
      for (const [index, step] of [3, 5, 8].entries()) {
        opened.log.inners[1].scrollTop = (index + 1) * 9
        tick(renderer, step)
      }
      renderer.drawFrame()
      expect(renderer.getRetainedCounters().mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
    } finally {
      opened.unmount()
    }
  })

})
