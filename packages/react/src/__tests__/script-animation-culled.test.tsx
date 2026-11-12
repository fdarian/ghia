/**
 * An `element.animate()` run on an element that is culled (clipped out of an `overflow: hidden` scroller) is dormant:
 * its clock is carried on without a build. Removing the element leaves the run going as an orphan, and the retained
 * frame that finds the destroyed id among the elements that stopped being dormant must not take the orphan's clock away:
 * `finished` has to resolve on time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const SCROLLER = 200
const BEFORE = 240

describeNative("element.animate() on a culled element that is removed", () => {
  let testRoot: ReturnType<typeof createTestRoot>
  const rows = new Map<number, PublicInstance>()

  beforeEach(() => {
    testRoot = createTestRoot({ width: 900, height: 1022 })
    testRoot.renderer.clockPause()
    testRoot.renderer.setInlineDraws(false)
    testRoot.renderer.setA11yActive(false)
  })

  afterEach(() => {
    testRoot.unmount()
    rows.clear()
  })

  function show(count: number): void {
    testRoot.render(
      <div style={{ width: 900, height: 1022, flexDirection: "row" }}>
        <div style={{ width: 200, flexDirection: "column", flexShrink: 0, padding: 4 }}>
          {Array.from({ length: 60 }, (_, index) => (
            <div key={index} style={{ height: 16, flexShrink: 0, padding: 1, display: "flex", borderRadius: 4, hover: { backgroundColor: "#e5e5e5" } }}>
              <div style={{ fontSize: 12, color: "#222222" }}>{`Sidebar item ${index}`}</div>
            </div>
          ))}
        </div>
        <div testId="scroller" style={{ flex: 1, height: SCROLLER, overflow: "hidden", flexDirection: "column" }}>
          <div style={{ height: BEFORE, flexShrink: 0 }} />
          {Array.from({ length: count }, (_, index) => (
            <div key={index} testId={`card-${index}`} style={{ height: 40, flexShrink: 0, padding: 8, backgroundColor: "#f4f4f4" }}>
              <div
                testId={`row-${index}`}
                ref={(instance: PublicInstance | null) => {
                  if (instance) rows.set(index, instance)
                }}
                style={{ height: 20, backgroundColor: "#cccccc" }}
              />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const tick = (milliseconds = 16) => {
    testRoot.renderer.clockAdvance(milliseconds)
    testRoot.renderer.advanceTime(milliseconds)
    testRoot.renderer.drawFrame()
    testRoot.renderer.dispatchNativeEvents()
  }

  it("finishes on time, which a dormant clock the removal did not take away tells", async () => {
    show(8)
    testRoot.renderer.flush()
    for (let warm = 0; warm < 12; warm++) tick()
    const row = rows.get(7) as unknown as HTMLElement
    const animation = row.animate({ opacity: [0, 1] }, { duration: 500, easing: "linear", fill: "forwards" })
    for (let step = 0; step < 12; step++) tick()
    // Dormant: the frames that carry the clock on build nothing.
    testRoot.renderer.resetBuildCounters()
    tick()
    tick()
    expect(testRoot.renderer.getBuildCounters().elementsBuilt, "nothing is built for a culled element's animation").toBe(0)

    show(7)
    testRoot.renderer.flush()
    for (let step = 0; step < 8; step++) tick()
    expect(animation.playState).toBe("running")

    let settled = false
    animation.finished.then(() => (settled = true))
    for (let step = 0; step < 50; step++) tick()
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(animation.playState).toBe("finished")
  })
})
