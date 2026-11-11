// @ts-nocheck
/**
 * What reads the boxes after a frame (`onLayout`, `ResizeObserver`, `IntersectionObserver`, and the `content-visibility: auto`
 * elements that skip their content when they are not near) is told about the rows of a list in the frames that move the rows in
 * place, as it is after a frame that built them: a canvas that the whole frame paints runs the sweep, and a frame that paints
 * nothing has no such canvas, so the translate runs it from the callback gpui runs after it. The entries of an
 * `IntersectionObserver` are those of the same wheels with the translate off.
 *
 * `onLayout` and `ResizeObserver` are not here: a translate changes no size, nor the place of a row in its parent. What `content-visibility`
 * and the sweep for it read cannot change by a translate either: a row is painted (and so swept) only as far as the overscan of its
 * recording, which is less than the margin that makes an element near. A virtual list reports no `scroll` event.
 *
 * Time moves as a display link would move it: a vsync moves the clock of the window and the executor's together, then the
 * wheel event of the tick arrives and the frame is drawn.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { IntersectionObserver } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its
// rows are built, not replayed, so there is nothing to translate after it (see `scroll-patch-translate.test.tsx`).
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined

const VSYNC = 16
const TIMEOUT = 120_000

function tick(renderer, by: number | undefined, x = 180, ms = VSYNC) {
  renderer.clockAdvance(ms)
  renderer.advanceTime(ms)
  if (by !== undefined) renderer.nativeSimulateScrollWheel(x, 60, 0, by)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

const scroll = (renderer) => renderer.getPatchCounters().scrollPatch

function open(page: React.ReactNode, translate: boolean, height = 200) {
  const root = createTestRoot({ width: 300, height })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(page)
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

const ROW = 40

describeNative("what reads the boxes in the frames that move the rows of a list", { timeout: TIMEOUT }, () => {
  /** Six rows of 40 in a view of 100: the first three are built, and the third is half in view. */
  function observed(translate: boolean, observe: (instances: unknown[], log: unknown[]) => void) {
    const log: unknown[] = []
    const instances: unknown[] = []
    const page = (
      <virtual-list testId="list" itemCount={6} estimatedItemHeight={ROW} overdraw={0} style={{ width: 200, height: 100, scrollbarWidth: "none" }}>
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            ref={(instance) => {
              if (instance) instances[index] = instance
            }}
            testId={`row-${index}`}
            style={{ width: 150, height: ROW, flexShrink: 0, backgroundColor: index % 2 === 0 ? "#223344" : "#334455" }}
          >
            <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
          </div>
        ))}
      </virtual-list>
    )
    const { renderer, unmount } = open(page, translate)
    try {
      observe(instances, log)
      renderer.dispatchNativeEvents()
      tick(renderer, 4)
      tick(renderer, -4)
      const before = scroll(renderer).patched
      // Rows 0 to 2 stay the rows of the view while it moves by 20.
      for (const by of [5, 5, 5, 5, -5, -5, -5, -5]) tick(renderer, by)
      return { log, patched: scroll(renderer).patched - before }
    } finally {
      unmount()
    }
  }

  it("tells an IntersectionObserver that a row is more in view, as the build does", () => {
    const watch = (instances, log) => {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) log.push([entry.intersectionRatio, entry.isIntersecting, entry.boundingClientRect.y])
        },
        { threshold: [0.25, 0.5, 0.75, 1] }
      )
      observer.observe(instances[2])
    }
    const on = observed(true, watch)
    const off = observed(false, watch)
    expect(off.log.length, "the third row crosses the thresholds as the rows move").toBeGreaterThan(2)
    expect(on.log).toEqual(off.log)
    if (!verifying) expect(on.patched).toBeGreaterThanOrEqual(6)
  })
})
