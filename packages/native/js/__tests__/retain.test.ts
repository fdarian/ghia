import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TestRenderer, hasNativeTestRenderer } from "../testing.js"

// A column of three cards, each with two lines of text.
const mount = (skipping = false) => {
  const renderer = new TestRenderer({ width: 400, height: 400 })
  // The counters judge what a frame builds, which a frame that skips builds less of.
  renderer.setRetainPlanning(skipping)
  renderer.clockPause()
  const batch: unknown[] = [
    ["createElement", 1, "div"],
    ["setRoot", 1],
    ["setStyle", 1, { display: "flex", flexDirection: "column", width: 300, color: "#223344" }],
  ]
  for (const card of [10, 20, 30]) {
    batch.push(["createElement", card, "div"], ["appendChild", 1, card], ["setStyle", card, { height: 40, hover: { backgroundColor: "#aa0000" } }])
    for (const line of [1, 2]) {
      const id = card + line
      batch.push(["createElement", id, "div"], ["appendChild", card, id], ["createElement", id * 10, "text"], ["setText", id * 10, "some words"], ["appendChild", id, id * 10])
    }
  }
  renderer.applyBatch(JSON.stringify(batch))
  renderer.setRetainVerify(!skipping)
  renderer.flush()
  return renderer
}

const reasons = (renderer: TestRenderer) => JSON.parse(renderer.getBuildCounters().retainReasons) as Record<string, number>

describe.skipIf(!hasNativeTestRenderer)("native retain counters", () => {
  it("counts a page that does not change as one retainable root, and every element once", () => {
    const renderer = mount()
    renderer.flush()
    renderer.resetBuildCounters()
    renderer.flush()
    const counters = renderer.getBuildCounters()
    expect(counters.retainableRoots).toBe(1)
    expect(counters.retainableElements).toBe(counters.elementsBuilt)
    expect(Object.values(reasons(renderer)).reduce((sum, count) => sum + count, 0)).toBe(counters.elementsBuilt)
    expect(counters.retainMismatches).toBe(0)
  })

  it("counts the element the pointer is over as changed, and its siblings as retainable", () => {
    const renderer = mount()
    renderer.flush()
    renderer.resetBuildCounters()
    const card = renderer.getElementBounds(10)!
    renderer.dispatchMouseMove(card.x + 2, card.y + 2)
    renderer.flush()
    const counters = renderer.getBuildCounters()
    expect(reasons(renderer)["changed:pointer"]).toBeGreaterThan(0)
    expect(counters.retainableElements).toBeGreaterThan(0)
    expect(counters.retainableElements).toBeLessThan(counters.elementsBuilt)
    expect(counters.retainMismatches, renderer.getRetainMismatches().join("\n")).toBe(0)
  })

  it("counts an element that cannot be reused under the reason, and counts it as reusable once the reason is lifted", () => {
    const renderer = mount()
    renderer.applyBatch(JSON.stringify([["setStyle", 20, { height: 40, overflow: "scroll" }]]))
    renderer.flush()
    renderer.flush()
    renderer.resetBuildCounters()
    renderer.flush()
    expect(reasons(renderer)["excluded:scroller"]).toBeGreaterThan(0)
    renderer.setRetainLift(["scroller"])
    renderer.flush()
    renderer.resetBuildCounters()
    renderer.flush()
    const counters = renderer.getBuildCounters()
    expect(reasons(renderer)["excluded:scroller"]).toBeUndefined()
    expect(counters.retainableElements).toBe(counters.elementsBuilt)
  })

  it("does not count an overflow: hidden element as an obstacle", () => {
    const renderer = mount()
    renderer.applyBatch(JSON.stringify([["setStyle", 20, { height: 40, overflow: "hidden" }]]))
    renderer.flush()
    renderer.flush()
    renderer.resetBuildCounters()
    renderer.flush()
    const counters = renderer.getBuildCounters()
    expect(counters.retainableElements).toBe(counters.elementsBuilt)
    expect(counters.retainMismatches).toBe(0)
  })

  it("builds none of a page that does not change, and replays it", () => {
    const renderer = mount(true)
    for (let frame = 0; frame < 4; frame++) renderer.flush()
    const before = renderer.getRetainedCounters()
    renderer.resetBuildCounters()
    renderer.flush()
    renderer.flush()
    const counters = renderer.getBuildCounters()
    expect(counters.elementsBuilt).toBe(0)
    expect(counters.elementsSkipped).toBeGreaterThan(0)
    expect(renderer.getRetainedCounters().replays).toBeGreaterThan(before.replays)
    expect(renderer.getRetainedCounters().mismatches).toBe(0)
  })

  it("rejects an exclusion it does not know", () => {
    const renderer = mount()
    expect(() => renderer.setRetainLift(["nonsense"])).toThrow(/no exclusion called nonsense/)
  })

  describe("rows of a virtual list", () => {
    const ROWS = 40
    const ROW_ELEMENTS = 4
    const ROW_HEIGHT = 40
    const rowId = (index: number) => 1000 + index * 10

    // A virtual list of 40 rows of four elements each (the row and three boxes, one holding a text), 40 px tall.
    const mountList = (skipping: boolean) => {
      const renderer = new TestRenderer({ width: 300, height: 300 })
      renderer.setRetainPlanning(skipping)
      renderer.setRetainEnabled(skipping)
      // The counters are judged on frames that skip, which a run under GPUIX_RETAIN_VERIFY does not make.
      renderer.setRetainVerify(false)
      renderer.clockPause()
      const batch: unknown[] = [
        ["createElement", 1, "div"],
        ["setRoot", 1],
        ["setStyle", 1, { width: 300, height: 300 }],
        ["createElement", 2, "virtual-list"],
        ["appendChild", 1, 2],
        ["setStyle", 2, { width: 300, height: 300 }],
      ]
      for (let index = 0; index < ROWS; index++) {
        const row = rowId(index)
        batch.push(
          ["createElement", row, "div"],
          ["appendChild", 2, row],
          ["setStyle", row, { height: 40, flexShrink: 0, display: "flex", flexDirection: "row" }],
          ["createElement", row + 1, "div"],
          ["appendChild", row, row + 1],
          ["setStyle", row + 1, { width: 100, height: 40, backgroundColor: "#335577" }],
          ["createElement", row + 2, "div"],
          ["appendChild", row, row + 2],
          ["setStyle", row + 2, { width: 100, height: 40, backgroundColor: "#775533" }],
          ["createElement", row + 4, "div"],
          ["appendChild", row, row + 4],
          ["setStyle", row + 4, { width: 100, height: 40, backgroundColor: "#557733" }],
          ["createElement", row + 3, "text"],
          ["setText", row + 3, `row ${index}`],
          ["appendChild", row + 1, row + 3],
        )
      }
      renderer.applyBatch(JSON.stringify(batch))
      for (let frame = 0; frame < 4; frame++) renderer.flush()
      return renderer
    }

    const restyle = (renderer: TestRenderer, index: number) => {
      renderer.applyBatch(JSON.stringify([["setStyle", rowId(index) + 2, { width: 100, height: 40, backgroundColor: "#aa0000" }]]))
    }

    it("builds the changed row and the chain, and skips the rows around it", () => {
      const renderer = mountList(true)
      const visible = Array.from({ length: ROWS }, (_, index) => renderer.getElementBounds(rowId(index))).filter(Boolean).length
      expect(visible).toBe(8)
      renderer.resetBuildCounters()
      restyle(renderer, 3)
      renderer.flush()
      const built = renderer.getBuildCounters()
      const retained = renderer.getRetainedCounters()
      const reasons = JSON.parse(built.retainReasons) as Record<string, number>
      expect(reasons["excluded:virtual-row"]).toBeUndefined()
      expect(reasons["excluded:virtual-list"]).toBeGreaterThan(0)
      expect(built.elementsBuilt).toBeLessThanOrEqual(4 + ROW_ELEMENTS)
      expect(built.elementsSkipped).toBeGreaterThanOrEqual((visible - 1) * ROW_ELEMENTS)
      expect(retained.layoutFallbacks).toBe(0)
      expect(retained.lazyBuilds).toBe(0)
      expect(Object.values(JSON.parse(retained.nonReusable) as Record<string, number>).every((count) => count === 0), retained.nonReusable).toBe(true)
      expect(built.retainMismatches).toBe(0)
    })

    const rowBounds = (renderer: TestRenderer, rows: number) =>
      Array.from({ length: rows }, (_, index) => [0, 1, 2, 3, 4].map((offset) => renderer.getElementBounds(rowId(index) + offset)))

    const picture = (renderer: TestRenderer) => {
      const path = join(mkdtempSync(join(tmpdir(), "retain-rows-")), "list.png")
      renderer.captureScreenshot(path)
      return readFileSync(path)
    }

    // The counters belong to the process and not to a window, so the run that is measured ends before the
    // oracle (the same steps with retention off) is mounted.
    const play = (skipping: boolean, steps: (renderer: TestRenderer) => void) => {
      const renderer = mountList(skipping)
      const retained = renderer.getRetainedCounters()
      const layout = renderer.getLayoutCounters()
      renderer.resetBuildCounters()
      steps(renderer)
      return {
        built: renderer.getBuildCounters(),
        retained: renderer.getRetainedCounters(),
        retainedBefore: retained,
        layout: renderer.getLayoutCounters(),
        layoutBefore: layout,
        bounds: rowBounds(renderer, 12),
        picture: picture(renderer),
      }
    }

    const misses = (counters: { relocationMisses: string }) => JSON.parse(counters.relocationMisses) as Record<string, number>

    const growRow = (renderer: TestRenderer, index: number) => {
      renderer.applyBatch(JSON.stringify([["setStyle", rowId(index), { height: 60, flexShrink: 0, display: "flex", flexDirection: "row" }]]))
    }

    it("builds one row and the chain for a read before the frame, and publishes the rows it skipped", () => {
      const renderer = mountList(true)
      renderer.setInlineDraws(false)
      renderer.drawFrame()
      renderer.resetBuildCounters()
      growRow(renderer, 3)
      const passes = renderer.getLayoutPassCount()
      const read = renderer.getElementBounds(rowId(5))
      expect(renderer.getLayoutPassCount()).toBe(passes + 1)
      const built = renderer.getBuildCounters()
      expect(built.elementsBuilt).toBeLessThanOrEqual(2 + ROW_ELEMENTS)
      expect(built.elementsSkipped).toBeGreaterThanOrEqual(6 * ROW_ELEMENTS)
      const boundsRead = rowBounds(renderer, 8)
      renderer.drawFrame()
      const boundsDrawn = rowBounds(renderer, 8)
      const retained = renderer.getRetainedCounters()
      expect(retained.lazyBuilds).toBe(0)
      expect(retained.layoutFallbacks).toBe(0)

      const oracle = mountList(false)
      oracle.setInlineDraws(false)
      oracle.drawFrame()
      growRow(oracle, 3)
      expect(oracle.getElementBounds(rowId(5))).toEqual(read)
      expect(rowBounds(oracle, 8)).toEqual(boundsRead)
      oracle.drawFrame()
      expect(rowBounds(oracle, 8)).toEqual(boundsDrawn)
    })

    it("moves the rows it keeps when the list scrolls by whole rows", () => {
      const scroll = (renderer: TestRenderer) => {
        renderer.scrollTo(2, undefined, ROW_HEIGHT * 2)
        renderer.flush()
        renderer.flush()
      }
      const kept = play(true, scroll)
      expect(kept.retained.relocations).toBeGreaterThan(kept.retainedBefore.relocations)
      expect(kept.retained.lazyBuilds).toBe(kept.retainedBefore.lazyBuilds)
      expect(kept.retained.layoutFallbacks).toBe(0)
      expect(kept.built.elementsSkipped).toBeGreaterThan(0)
      expect(kept.built.retainMismatches).toBe(0)
      const built = play(false, scroll)
      expect(kept.bounds).toEqual(built.bounds)
      expect(kept.picture.equals(built.picture)).toBe(true)
    })

    it("places the rows it keeps when a wheel leaves the list a fraction of a row down", () => {
      const wheel = (renderer: TestRenderer) => {
        renderer.dispatchScrollWheel(100, 100, 0, ROW_HEIGHT + 0.5)
        renderer.flush()
        renderer.flush()
      }
      const kept = play(true, wheel)
      expect(kept.retained.relocations).toBeGreaterThan(kept.retainedBefore.relocations)
      expect(kept.retained.lazyBuilds).toBe(kept.retainedBefore.lazyBuilds)
      expect(misses(kept.retained).Place).toBe(0)
      expect(kept.built.retainMismatches).toBe(0)
      const built = play(false, wheel)
      expect(kept.bounds).toEqual(built.bounds)
      expect(kept.picture.equals(built.picture)).toBe(true)
    })

    it("replays the rows around one whose height changed, and paints what a build of every row paints", () => {
      const grow = (renderer: TestRenderer) => {
        growRow(renderer, 3)
        renderer.flush()
      }
      const kept = play(true, grow)
      expect(kept.built.elementsBuilt).toBeLessThanOrEqual(2 + ROW_ELEMENTS)
      expect(kept.built.elementsSkipped).toBeGreaterThanOrEqual(6 * ROW_ELEMENTS)
      expect(kept.retained.relocations).toBeGreaterThan(kept.retainedBefore.relocations)
      expect(kept.retained.layoutFallbacks).toBe(0)
      expect(kept.retained.lazyBuilds).toBe(kept.retainedBefore.lazyBuilds)
      const built = play(false, grow)
      expect(kept.bounds).toEqual(built.bounds)
      expect(kept.bounds[4][0]?.y).toBe(ROW_HEIGHT * 4 + 20)
      expect(kept.picture.equals(built.picture)).toBe(true)
    })

    it("creates and removes no layout node for the rows it keeps", () => {
      const kept = play(true, (renderer) => {
        restyle(renderer, 3)
        renderer.flush()
      })
      expect(kept.layout.nodesCreated - kept.layoutBefore.nodesCreated).toBe(0)
      expect(kept.layout.nodesRemoved - kept.layoutBefore.nodesRemoved).toBe(0)
    })

    it("agrees with a build of the frame, row by row, under the verifier", () => {
      const renderer = mountList(true)
      renderer.setRetainVerify(true)
      for (let frame = 0; frame < 3; frame++) renderer.flush()
      restyle(renderer, 3)
      renderer.flush()
      renderer.flush()
      expect(renderer.getRetainMismatches()).toEqual([])
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
    })

    it("paints what a build of every row paints", () => {
      const dir = mkdtempSync(join(tmpdir(), "retain-rows-"))
      const shot = (skipping: boolean) => {
        const renderer = mountList(skipping)
        restyle(renderer, 3)
        renderer.flush()
        renderer.flush()
        const path = join(dir, `${skipping}.png`)
        renderer.captureScreenshot(path)
        const bounds = Array.from({ length: 8 }, (_, index) => renderer.getElementBounds(rowId(index) + 2))
        return { bytes: readFileSync(path), bounds }
      }
      const retained = shot(true)
      const built = shot(false)
      expect(retained.bytes.length).toBeGreaterThan(2000)
      expect(retained.bounds).toEqual(built.bounds)
      expect(retained.bytes.equals(built.bytes)).toBe(true)
    })
  })

  describe("under GPUIX_RETAIN_VERIFY", () => {
    afterEach(() => vi.unstubAllEnvs())

    // A finding of gpuix's own check is only produced by a build that disagrees with a record, which
    // a page cannot be made to do on demand, so the finding is put where the native renderer lists it.
    const withFinding = (renderer: TestRenderer, finding: string) => {
      const native = (renderer as unknown as { native: { getRetainMismatches(): string[] } }).native
      native.getRetainMismatches = () => [finding]
    }

    it("makes dispose throw on an element judged unchanged that was built differently", () => {
      vi.stubEnv("GPUIX_RETAIN_VERIFY", "1")
      const renderer = mount()
      withFinding(renderer, "element 7 was judged unchanged and built differently")
      expect(() => renderer.dispose()).toThrow("element 7 was judged unchanged and built differently")
    })

    it("lets dispose pass when the window has no finding", () => {
      vi.stubEnv("GPUIX_RETAIN_VERIFY", "1")
      const renderer = mount()
      renderer.flush()
      expect(() => renderer.dispose()).not.toThrow()
    })
  })
})
