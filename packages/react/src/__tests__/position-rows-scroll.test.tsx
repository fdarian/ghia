/// The rows of a TanStack Virtual list: an `overflow: auto` scroller, one `position: relative` container as
/// high as every row together, and rows that are `position: absolute` at the top left of it, each moved down by
/// a `transform` and holding an absolutely positioned box of its own. A scroll by a few pixels moves what the
/// rows are in and nothing about the rows, so the frame replays them a whole number of pixels away from where
/// they were recorded instead of building them (a row lifts itself, but nothing lifts out of the context its
/// transform forms), and what it shows and answers is what a build shows and answers.

import fs from "fs"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ROWS = 60
const ROW_HEIGHT = 40
const VIEW = { width: 300, height: 240 }
const TAG = { left: 120, top: 6, width: 50, height: 10 }
const RED = [255, 0, 0, 255]

function Rows(props: { clicks: number[] }) {
  return (
    <div testId="scroller" style={{ ...VIEW, overflow: "auto" }}>
      <div testId="container" style={{ position: "relative", width: "100%", height: ROWS * ROW_HEIGHT }}>
        {Array.from({ length: ROWS }, (_, index) => (
          <div
            key={index}
            testId={`row-${index}`}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: ROW_HEIGHT,
              transform: `translateY(${index * ROW_HEIGHT}px)`,
              backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
            }}
          >
            <div style={{ fontSize: 14, color: "#ffffff" }}>{`Row ${index}`}</div>
            <div
              testId={`tag-${index}`}
              onClick={() => props.clicks.push(index)}
              style={{
                position: "absolute",
                left: TAG.left,
                top: TAG.top,
                width: TAG.width,
                height: TAG.height,
                backgroundColor: "#ff0000",
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function setup(verify: boolean) {
  const clicks: number[] = []
  const root = createTestRoot(VIEW)
  const renderer = root.renderer
  renderer.setRetainPlanning(true)
  renderer.setRetainVerify(verify)
  root.render(<Rows clicks={clicks} />)
  for (let frame = 0; frame < 5; frame++) renderer.flush()
  const scroller = renderer.findByTestId("scroller")!
  const id = (testId: string) => renderer.findByTestId(testId)!.id
  const sample = (name: string, x: number, y: number) => {
    const file = `${SHOTS_DIR}/position-rows-scroll-${process.pid}-${name}.png`
    fs.rmSync(file, { force: true })
    renderer.captureScreenshot(file)
    return readLogicalPixels(file, renderer).at(x, y)
  }
  const scrollTo = (top: number) => {
    renderer.scrollTo(scroller.id, 0, top, "instant")
    renderer.flush()
  }
  return { ...root, clicks, id, sample, scrollTo, counters: () => renderer.getRetainedCounters() }
}

/** The rows with a tag in the viewport at `scrolled`, and where the tag is. */
function visibleTags(scrolled: number) {
  const first = Math.floor(scrolled / ROW_HEIGHT)
  const last = Math.floor((scrolled + VIEW.height - 1) / ROW_HEIGHT)
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset)
    .map((index) => ({ index, y: index * ROW_HEIGHT + TAG.top - scrolled }))
    .filter((tag) => tag.y >= 0 && tag.y + TAG.height <= VIEW.height)
}

const STEPS = [3, 4, 9, 10, 19, 20, 36, 37, 61, 62, 100, 101, 130, 70, 69, 12, 0]

describeNative("rows that are positioned, moved by a transform and hold a positioned box, in a scroller", () => {
  it.each([true, false])("show and answer where the scroll puts them, with the verifier %s", (verify) => {
    const { renderer, id, sample, scrollTo, counters, clicks, unmount } = setup(verify)
    try {
      const before = counters()
      for (const scrolled of STEPS) {
        scrollTo(scrolled)
        for (const tag of visibleTags(scrolled)) {
          const label = `scrolled to ${scrolled}, row ${tag.index}`
          expect(renderer.getElementBounds(id(`tag-${tag.index}`)), label).toMatchObject({ x: TAG.left, y: tag.y })
          expect(renderer.getElementsAt(TAG.left + 5, tag.y + 5), label).toContain(id(`tag-${tag.index}`))
          expect(renderer.getElementBounds(id(`row-${tag.index}`)), label).toMatchObject({ y: tag.index * ROW_HEIGHT - scrolled })
        }
        const middle = visibleTags(scrolled)[1]
        expect(sample(`step-${scrolled}`, TAG.left + 5, middle.y + 5), `scrolled to ${scrolled}`).toEqual(RED)
        expect(sample(`step-${scrolled}-beside`, TAG.left - 10, middle.y + 5), `scrolled to ${scrolled}`).not.toEqual(RED)
      }
      const middle = visibleTags(0)[1]
      scrollTo(0)
      renderer.nativeSimulateClick(TAG.left + 5, middle.y + 5)
      expect(clicks).toEqual([middle.index])

      const after = counters()
      expect(after.mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
      expect(after.relocations, "a scroll moves the rows, it does not build them").toBeGreaterThan(before.relocations)
      if (verify) expect(after.verified).toBeGreaterThan(before.verified)
      // Counted over the frames of the scroll steps and of the screenshots between them: with the rows built
      // (every row of a TanStack list lifts itself) 2026 of them are relocated, with the context of a row
      // keeping what lifts in it 9960. The verifier shows the build of a frame that replays, which keeps what was
      // recorded where it was, so only a run without it counts the moves.
      if (!verify) expect(after.relocations - before.relocations).toBeGreaterThan(5000)
    } finally {
      unmount()
    }
  }, 60_000)
})
