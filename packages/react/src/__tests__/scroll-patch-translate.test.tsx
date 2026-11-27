// @ts-nocheck
/**
 * The frames drawn after a list scroll that are a pure translate of the rows of the frame shown are drawn as one: the operations
 * and hitboxes of the rows are made again from their recordings at the new place, what the rows wrote into the registries is
 * moved, and nothing is built (`getPatchCounters().scrollPatch.patched`). The picture, the boxes of the rows, what is under a
 * point, the cursor and the hover are what they are with the translate off (`setScrollPatchEnabled(false)`). Rows of 40 in a view
 * of 100, in a list with no scrollbar (the thumb of one is in `scroll-patch-thumb.test.tsx`), and rows narrower than
 * the list so that a pointer in the gutter takes no row.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its
// rows are built, not replayed, so there is nothing to translate after it. The first translate after a frame that is not
// verified is, and the verifier compares it with the frame built whole (the cases that count translates skip there).
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const ROW_WIDTH = 150
const TIMEOUT = 60_000

/** A scroller in a row, as the cards of a mailbox have: its offset is what a script writes, and it is no scroller of the frame shown. */
type Inners = Record<number, { scrollTop: number }>

function Page({ text, tint, inners, salt = 0 }: { text: boolean; tint: number; inners?: Inners; salt?: number }) {
  return (
    <virtual-list
      testId="list"
      itemCount={COUNT}
      estimatedItemHeight={ROW}
      overdraw={0}
      style={{ width: 200, height: VIEWPORT, scrollbarWidth: "none" }}
    >
      {Array.from({ length: COUNT }, (_, index) => (
        <div
          key={index}
          testId={`row-${index}`}
          style={{
            width: ROW_WIDTH,
            height: ROW,
            flexShrink: 0,
            position: inners ? "relative" : undefined,
            backgroundColor: (index + salt) % 2 === 0 ? "#223344" : "#334455",
            borderBottom: tint > 0 && index === 2 ? "4px solid #ff0000" : undefined,
            hover: { backgroundColor: "#664422" },
          }}
        >
          {inners ? (
            <div
              ref={(instance) => {
                if (instance !== null) inners[index] = instance
              }}
              testId={`inner-${index}`}
              style={{ position: "absolute", left: 90, top: 4, width: 40, height: 30, overflowY: "auto" }}
            >
              {["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff"].map((color) => (
                <div key={color} style={{ height: 30, flexShrink: 0, backgroundColor: color }} />
              ))}
            </div>
          ) : null}
          {text ? <div style={{ color: "#ffffff" }}>{`row-${index}`}</div> : null}
        </div>
      ))}
    </virtual-list>
  )
}

function open(text = true, inners?: Inners) {
  const root = createTestRoot({ width: 300, height: 200 })
  root.render(<Page text={text} tint={0} inners={inners} />)
  root.renderer.dispatchNativeEvents()
  root.renderer.flush()
  root.renderer.setA11yActive(false)
  // A commit that is not drawn yet when the next wheel arrives.
  return {
    ...root,
    renderer: root.renderer,
    commit: () => root.render(<Page text={text} tint={1} inners={inners} />),
    // Every row changes: they are built, and a build of the rows records them.
    rebuild: () => root.render(<Page text={text} tint={0} inners={inners} salt={1} />),
  }
}

type Wheel = { x: number; y: number; by: number }

function wheel(renderer, { x, y, by }: Wheel) {
  renderer.nativeSimulateScrollWheel(x, y, 0, by)
  renderer.dispatchNativeEvents()
}

const shotFile = (name: string) => `${SHOTS_DIR}/scroll-patch-translate-${process.pid}-${name}.png`

/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer, name: string): string {
  const file = shotFile(name)
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

function scroll(renderer) {
  return renderer.getPatchCounters().scrollPatch
}

/** What a test observes of the page after a step. */
function seen(renderer, name: string, points: Array<[number, number]>) {
  return {
    boxes: boxes(renderer),
    under: points.map(([x, y]) => renderer.getElementsAt(x, y)),
    cursor: renderer.getCursor(),
    picture: picture(renderer, name),
  }
}

/** The steps run on a page with the translate on or off; each is seen after. */
function run(translate: boolean, steps: Wheel[], points: Array<[number, number]>, between?: (index: number) => void, ended = false) {
  const { renderer, unmount } = open()
  try {
    renderer.setScrollPatchEnabled(translate)
    // The first frames record the rows; a wheel and its way back put them elsewhere.
    wheel(renderer, { x: steps[0].x, y: steps[0].y, by: 4 })
    wheel(renderer, { x: steps[0].x, y: steps[0].y, by: -4 })
    // A hover is where the last pointer input put it.
    if (ended) renderer.nativeSimulateMouseMove(steps[0].x, steps[0].y)
    const frames: unknown[] = []
    const translated: boolean[] = []
    for (const [index, step] of steps.entries()) {
      between?.(index)
      const before = scroll(renderer).patched
      wheel(renderer, step)
      translated.push(scroll(renderer).patched > before)
      frames.push(seen(renderer, `${translate}-${index}`, points))
    }
    if (ended) {
      // The hover follows the scroll once the wheel has been quiet: the row under the pointer is restyled then.
      renderer.advanceTime(500)
      renderer.drawFrame()
      renderer.drawFrame()
      frames.push(seen(renderer, `${translate}-end`, points))
    }
    return { frames, translated, counters: scroll(renderer) }
  } finally {
    unmount()
  }
}

describeNative("the rows of a list translated by a scroll", { timeout: TIMEOUT }, () => {
  // The pointer at x = 180 is in the gutter of the list, beside the rows (150 wide): it takes no hover.
  const gutter: Wheel[] = [3, 5, 8, -4, -9, 6, 2, 7].map((by) => ({ x: 180, y: 60, by }))

  unverified("draws the frames of fractions of a row as translates, and the same picture, boxes and hits as the build", () => {
    const on = run(true, gutter, [[20, 10], [20, 50], [180, 60], [100, 99]])
    const off = run(false, gutter, [[20, 10], [20, 50], [180, 60], [100, 99]])
    expect(off.counters.frames).toBe(0)
    expect(on.counters.mispredicted).toBe(0)
    expect(on.counters.patched).toBeGreaterThan(0)
    expect(on.translated, "every frame that is compared was drawn as a translate").toEqual(gutter.map(() => true))
    expect(off.translated.some(Boolean)).toBe(false)
    expect(on.counters.eligible).toBe(on.counters.patched + Object.values(on.counters.applyDeclines).reduce((a, b) => a + b, 0))
    expect(on.frames).toEqual(off.frames)
  })

  it("draws the same picture, boxes and hits whatever the rows are doing (also under the verifier)", () => {
    const on = run(true, gutter, [[20, 10], [180, 60]])
    const off = run(false, gutter, [[20, 10], [180, 60]])
    // Under the verifier the frame shown is the build the verifier makes whole: nothing is translated to compare.
    if (!verifying) expect(on.translated, "every frame that is compared was drawn as a translate").toEqual(gutter.map(() => true))
    expect(off.translated.some(Boolean)).toBe(false)
    expect(on.frames).toEqual(off.frames)
  })

  unverified("leaves the hover on the row it was on while the rows move under the pointer, and restyles the row under it when the scroll ends, as the build does", () => {
    // The pointer at (20, 38) is in the row 0 and then, 5 up, still in it: a translate with the hover style on the row that
    // moves. 5 more crosses into the row 1: every step is a translate, and the hover follows once the wheel is quiet
    // (`hover-after-scroll.test.tsx`, `scroll-patch-hover.test.tsx`).
    const steps: Wheel[] = [3, 2, 1, 5, 2, 2, -4, -4].map((by) => ({ x: 20, y: 38, by }))
    const on = run(true, steps, [[20, 38], [20, 10]], undefined, true)
    const off = run(false, steps, [[20, 38], [20, 10]], undefined, true)
    expect(on.counters.patched).toBeGreaterThan(0)
    expect(on.translated).toEqual([true, true, true, true, true, true, true, true])
    expect(on.frames).toEqual(off.frames)
    expect(on.frames.at(-1).picture, "the hover moved when the scroll ended").not.toEqual(on.frames.at(-2).picture)
  })

  unverified("draws a whole frame for a commit between the wheel events, and a translate again after it", () => {
    const sequence = (translate: boolean) => {
      const { renderer, unmount, commit } = open()
      try {
        renderer.setScrollPatchEnabled(translate)
        wheel(renderer, { x: 180, y: 60, by: 4 })
        wheel(renderer, { x: 180, y: 60, by: -4 })
        wheel(renderer, { x: 180, y: 60, by: 3 })
        const before = scroll(renderer)
        // The commit and the wheel event come before the frame that draws them both.
        renderer.setInlineDraws(false)
        commit()
        wheel(renderer, { x: 180, y: 60, by: 3 })
        renderer.drawFrame()
        renderer.setInlineDraws(true)
        const committed = scroll(renderer)
        wheel(renderer, { x: 180, y: 60, by: 3 })
        wheel(renderer, { x: 180, y: 60, by: 3 })
        return { before, committed, after: scroll(renderer), seen: seen(renderer, `commit-${translate}`, [[20, 10]]) }
      } finally {
        unmount()
      }
    }
    const on = sequence(true)
    expect(on.before.patched).toBeGreaterThan(0)
    expect(on.committed.patched).toBe(on.before.patched)
    expect(on.committed.reasons.Edited).toBe(1)
    expect(on.after.patched).toBeGreaterThan(on.committed.patched)
    expect(on.seen).toEqual(sequence(false).seen)
  })

  unverified("moves the boxes of the rows a translate left in the frame, for a read that comes after it", () => {
    const { renderer, unmount } = open()
    try {
      wheel(renderer, { x: 180, y: 60, by: 4 })
      wheel(renderer, { x: 180, y: 60, by: -4 })
      const row = renderer.findByType("div").find((element) => element.testId === "row-1")
      const top = renderer.getElementBounds(row.id).y
      wheel(renderer, { x: 180, y: 60, by: 6 })
      expect(scroll(renderer).patched).toBeGreaterThan(0)
      // The row went up by 6 and a read of its box says so without drawing again.
      expect(renderer.getElementBounds(row.id).y).toBe(top - 6)
      expect(renderer.getElementsAt(20, top - 6 + 1)).toContain(row.id)
    } finally {
      unmount()
    }
  })

  /**
   * The rows hold a scroller each, which a page moves by script (`scrollTop = n`, instant, no commit) from a handler of another
   * scroller: such a wheel step is a frame built whole, and the frame after is right. (A row that holds a scroller is no run of the list in
   * Ghia, so no step here is a translate; the gate's answer for a scroller gpui does not know is pinned by `retain.rs` and zed.)
   */
  function scriptedInner(translate: boolean) {
    const inners: Inners = {}
    const { renderer, unmount, commit, rebuild } = open(true, inners)
    try {
      renderer.setScrollPatchEnabled(translate)
      wheel(renderer, { x: 180, y: 60, by: 4 })
      wheel(renderer, { x: 180, y: 60, by: -4 })
      // The commit builds the rows: the frame shown records the scroller in each, and knows it as no scroller.
      renderer.setInlineDraws(false)
      rebuild()
      renderer.drawFrame()
      renderer.setInlineDraws(true)
      const frames: unknown[] = []
      const translated: boolean[] = []
      for (const [index, by] of [3, 5, 8, -2, 6].entries()) {
        inners[1].scrollTop = (index + 1) * 9
        const before = scroll(renderer).patched
        wheel(renderer, { x: 180, y: 60, by })
        translated.push(scroll(renderer).patched > before)
        const inner = renderer.findByTestId("inner-1")
        frames.push({ ...seen(renderer, `inner-${translate}-${index}`, [[20, 10]]), inner: renderer.getScrollOffset(inner.id) })
      }
      renderer.setInlineDraws(false)
      commit()
      renderer.drawFrame()
      renderer.setInlineDraws(true)
      const inner = renderer.findByTestId("inner-1")
      const whole = { ...seen(renderer, `inner-whole-${translate}`, [[20, 10]]), inner: renderer.getScrollOffset(inner.id) }
      return { frames, translated, whole, counters: scroll(renderer) }
    } finally {
      unmount()
    }
  }

  it("draws what a build gives when script moved a scroller inside a row, and the frame after it", () => {
    const on = scriptedInner(true)
    const off = scriptedInner(false)
    expect(on.frames).toEqual(off.frames)
    expect(on.whole).toEqual(off.whole)
    expect(on.whole.inner, "the inner scroller is where the script put it").toEqual([0, 45])
    expect(on.counters.mispredicted).toBe(0)
  })

  it("draws the frames whole with the translate off", () => {
    const { renderer, unmount } = open()
    try {
      renderer.setScrollPatchEnabled(false)
      wheel(renderer, { x: 180, y: 60, by: 4 })
      wheel(renderer, { x: 180, y: 60, by: 4 })
      expect(scroll(renderer).frames).toBe(0)
      expect(scroll(renderer).patched).toBe(0)
    } finally {
      unmount()
    }
  })
})
