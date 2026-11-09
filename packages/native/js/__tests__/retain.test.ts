import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

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
  renderer.applyBatch(encodeWireBatchForTest(batch))
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
    renderer.applyBatch(encodeWireBatchForTest([["setStyle", 20, { height: 40, overflow: "scroll" }]]))
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
    renderer.applyBatch(encodeWireBatchForTest([["setStyle", 20, { height: 40, overflow: "hidden" }]]))
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

    // A mailbox row: `position: relative` with two absolutely positioned children, one of which reaches into the
    // row below. Its own position is the only thing that lifts, and the row is the context its children are
    // consumed by.
    type Shape = { rowStyle?: Record<string, unknown> }
    const MAILBOX_ROW = { height: 40, flexShrink: 0, position: "relative" }

    // A virtual list of 40 rows of four elements each (the row and three boxes, one holding a text), 40 px tall.
    const mountList = (skipping: boolean, mailbox?: Shape) => {
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
        const rowStyle = mailbox
          ? { ...MAILBOX_ROW, backgroundColor: index % 2 ? "#ddccdd" : "#ccddcc", ...mailbox.rowStyle }
          : { height: 40, flexShrink: 0, display: "flex", flexDirection: "row" }
        const boxes = mailbox
          ? [
              { width: 100, height: 40, backgroundColor: "#335577" },
              { position: "absolute", left: 120, top: 4, width: 20, height: 20, backgroundColor: "#775533" },
              { position: "absolute", left: 180, top: 30, width: 40, height: 20, backgroundColor: "#557733" },
            ]
          : [
              { width: 100, height: 40, backgroundColor: "#335577" },
              { width: 100, height: 40, backgroundColor: "#775533" },
              { width: 100, height: 40, backgroundColor: "#557733" },
            ]
        batch.push(
          ["createElement", row, "div"],
          ["appendChild", 2, row],
          ["setStyle", row, rowStyle],
          ["createElement", row + 1, "div"],
          ["appendChild", row, row + 1],
          ["setStyle", row + 1, boxes[0]],
          ["createElement", row + 2, "div"],
          ["appendChild", row, row + 2],
          ["setStyle", row + 2, boxes[1]],
          ["createElement", row + 4, "div"],
          ["appendChild", row, row + 4],
          ["setStyle", row + 4, boxes[2]],
          ["createElement", row + 3, "text"],
          ["setText", row + 3, `row ${index}`],
          ["appendChild", row + 1, row + 3],
        )
      }
      renderer.applyBatch(encodeWireBatchForTest(batch))
      for (let frame = 0; frame < 4; frame++) renderer.flush()
      return renderer
    }

    const restyle = (renderer: TestRenderer, index: number) => {
      renderer.applyBatch(encodeWireBatchForTest([["setStyle", rowId(index) + 2, { width: 100, height: 40, backgroundColor: "#aa0000" }]]))
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
    const play = (skipping: boolean, steps: (renderer: TestRenderer) => void, mailbox?: Shape) => {
      const renderer = mountList(skipping, mailbox)
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
      renderer.applyBatch(encodeWireBatchForTest([["setStyle", rowId(index), { height: 60, flexShrink: 0, display: "flex", flexDirection: "row" }]]))
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

    describe("rows that lift", () => {
      const scrollRows = (renderer: TestRenderer) => {
        renderer.scrollTo(2, undefined, ROW_HEIGHT * 2)
        renderer.flush()
        renderer.flush()
        renderer.scrollTo(2, undefined, ROW_HEIGHT * 5)
        renderer.flush()
        renderer.flush()
      }

      it("moves the rows of a mailbox without building them: the row's own position is not a lift out of the list", () => {
        const scroll = (renderer: TestRenderer) => {
          renderer.scrollTo(2, undefined, ROW_HEIGHT * 2)
          renderer.flush()
          renderer.flush()
        }
        const kept = play(true, scroll, {})
        expect(kept.retained.relocations).toBeGreaterThan(kept.retainedBefore.relocations)
        expect(kept.retained.lazyBuilds).toBe(kept.retainedBefore.lazyBuilds)
        expect(kept.retained.layoutFallbacks).toBe(0)
        expect(kept.built.retainMismatches).toBe(0)
        const built = play(false, scroll, {})
        expect(kept.bounds).toEqual(built.bounds)
        expect(kept.picture.equals(built.picture)).toBe(true)
      })

      it("scrolls the rows of a mailbox as it scrolls rows that do not lift", () => {
        const mailbox = play(true, scrollRows, {})
        const plain = play(true, scrollRows)
        const delta = (run: typeof mailbox, key: "relocations" | "lazyBuilds") => run.retained[key] - run.retainedBefore[key]
        expect(delta(mailbox, "relocations")).toBeGreaterThan(0)
        expect(delta(mailbox, "relocations")).toBe(delta(plain, "relocations"))
        expect(delta(mailbox, "lazyBuilds")).toBe(delta(plain, "lazyBuilds"))
        expect(mailbox.retained.nonRelocatable).toEqual(plain.retained.nonRelocatable)
      })

      it("agrees with a build of the frame under the verifier while the rows of a mailbox are scrolled", () => {
        const renderer = mountList(true, {})
        renderer.setRetainVerify(true)
        for (let frame = 0; frame < 3; frame++) renderer.flush()
        scrollRows(renderer)
        renderer.scrollTo(2, undefined, ROW_HEIGHT * 3)
        renderer.flush()
        renderer.flush()
        expect(renderer.getRetainMismatches()).toEqual([])
        expect(renderer.getRetainedCounters().mismatches).toBe(0)
      })

      // The list's lift barrier takes the lift of the row root, so a row with an index, a negative one, a
      // composite or a position other than relative paints where it would if it did not lift.
      it.each([
        ["a relative position only", {}],
        ["a z-index", { zIndex: 5 }],
        ["a negative z-index", { zIndex: -3 }],
        ["an opacity below 1", { opacity: 0.9 }],
        ["a transform", { transform: "translateX(2px)" }],
        ["position: sticky", { position: "sticky", top: 0 }],
        ["position: absolute", { position: "absolute", left: 0, top: 0, width: 300 }],
      ])("paints a row with %s as a build of every row does", (_, rowStyle) => {
        const steps = (renderer: TestRenderer) => {
          renderer.scrollTo(2, undefined, ROW_HEIGHT * 2)
          renderer.flush()
          renderer.flush()
        }
        const kept = play(true, steps, { rowStyle })
        expect(kept.built.retainMismatches).toBe(0)
        const built = play(false, steps, { rowStyle })
        expect(kept.bounds).toEqual(built.bounds)
        expect(kept.picture.equals(built.picture)).toBe(true)
      })
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

    it("agrees with a build of the frame when a row comes back after a frame the list did not ask for it", () => {
      const renderer = mountList(true)
      renderer.setRetainVerify(true)
      for (let frame = 0; frame < 3; frame++) renderer.flush()
      // 40 px takes row 0 out of the viewport for a frame, which 20 or 39 px do not: its box is gone while
      // its record is not, and the row comes back with the scroll.
      renderer.scrollTo(2, undefined, ROW_HEIGHT)
      renderer.flush()
      expect(renderer.getElementBounds(rowId(0))).toBeFalsy()
      renderer.scrollTo(2, undefined, 0)
      renderer.flush()
      renderer.flush()
      expect(renderer.getRetainMismatches()).toEqual([])
      expect(renderer.getBuildCounters().retainMismatches).toBe(0)
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
      expect(renderer.getElementBounds(rowId(0))).toBeTruthy()
    })

    // A list of rows that are each a flex row of a box with a text (A) and a box with a hover (B, optionally with a
    // transition on its background, or holding a box of its own with a text when `deep`), for scenarios that touch an
    // element under a row and scroll away from it.
    const mountNestedList = (rows: number, transition: boolean, deep = false) => {
      const renderer = new TestRenderer({ width: 300, height: 300 })
      renderer.setRetainPlanning(true)
      renderer.setRetainEnabled(true)
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
      for (let index = 0; index < rows; index++) {
        const row = rowId(index)
        const boxB: Record<string, unknown> = deep
          ? { width: 100, height: ROW_HEIGHT, display: "flex", backgroundColor: "#775533" }
          : { width: 100, height: 30, backgroundColor: "#775533", hover: { backgroundColor: "#ff00ff" } }
        if (transition) boxB.transition = "background-color 200ms linear"
        batch.push(
          ["createElement", row, "div"],
          ["appendChild", 2, row],
          ["setStyle", row, { height: ROW_HEIGHT, flexShrink: 0, display: "flex", flexDirection: "row" }],
          ["createElement", row + 1, "div"],
          ["appendChild", row, row + 1],
          ["setStyle", row + 1, { width: 100, height: ROW_HEIGHT, backgroundColor: "#335577" }],
          ["createElement", row + 3, "text"],
          ["setText", row + 3, `row ${index}`],
          ["appendChild", row + 1, row + 3],
          ["createElement", row + 2, "div"],
          ["appendChild", row, row + 2],
          ["setStyle", row + 2, boxB],
        )
        if (deep) {
          batch.push(
            ["createElement", row + 5, "div"],
            ["appendChild", row + 2, row + 5],
            ["setStyle", row + 5, { width: 50, height: 20, backgroundColor: "#112233" }],
            ["createElement", row + 6, "text"],
            ["setText", row + 6, `nested ${index}`],
            ["appendChild", row + 5, row + 6],
          )
        } else {
          batch.push(["createElement", row + 5, "text"], ["setText", row + 5, `n${index}`], ["appendChild", row + 2, row + 5])
        }
      }
      renderer.applyBatch(encodeWireBatchForTest(batch))
      for (let frame = 0; frame < 4; frame++) renderer.flush()
      return renderer
    }
    const frames = (renderer: TestRenderer, count: number) => {
      for (let frame = 0; frame < count; frame++) {
        renderer.clockAdvance(16)
        renderer.flush()
      }
    }
    const recordCount = (renderer: TestRenderer) =>
      (renderer as unknown as { native: { getRetainRecordCounts(): number[] } }).native.getRetainRecordCounts()[0]

    it("agrees with a build of the frame when a row with a transition underneath comes back", () => {
      // A box of row 3 runs a transition under the pointer, so the build of the row skips the box beside it (A, with a
      // text). The row leaves the viewport and returns: what it held, A and its text included, has to be built again.
      const renderer = mountNestedList(60, true)
      renderer.setRetainVerify(true)
      for (let frame = 0; frame < 3; frame++) renderer.flush()
      renderer.nativeSimulateMouseMove(150, 135)
      frames(renderer, 30)
      renderer.scrollTo(2, undefined, 400)
      frames(renderer, 2)
      renderer.scrollTo(2, undefined, 0)
      frames(renderer, 2)
      expect(renderer.getRetainMismatches()).toEqual([])
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
    })

    it("keeps no more records than the viewport holds when the rows scrolled through are restyled", () => {
      const rows = 400
      const renderer = mountNestedList(rows, false, true)
      const start = recordCount(renderer)
      let most = start
      for (let top = 0; top < rows - 8; top += 4) {
        renderer.scrollTo(2, undefined, top * ROW_HEIGHT)
        renderer.flush()
        renderer.flush()
        const ops = []
        for (let index = top; index < top + 7; index++) {
          ops.push(["setStyle", rowId(index) + 1, { width: 100, height: ROW_HEIGHT, backgroundColor: `#33557${top % 10}` }])
        }
        renderer.applyBatch(encodeWireBatchForTest(ops))
        renderer.flush()
        renderer.flush()
        most = Math.max(most, recordCount(renderer))
      }
      // A record for every element ever built was 808 at the end of this walk.
      expect(most).toBeLessThan(start * 2)
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
