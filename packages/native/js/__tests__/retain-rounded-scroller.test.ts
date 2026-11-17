import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

const ROW_HEIGHT = 40
const SIZE = 300
const RADIUS = 24
const SCROLLER = 2
// Room above and below the card, so that its corners are in the scroller and not cut by it at some offsets.
const CARD_MARGIN = 60
const CARD_ROOM_BELOW = 200

type Shape = "scroller in a rounded panel" | "rounded card in a scroller"

const rowId = (index: number) => 1000 + index * 10

// Rows of three elements (the row, a box, a text), each a retained root, in a scroller that is a plain rectangle.
// The rounded mask is the panel the scroller fills, or a card that holds the rows and scrolls with them.
const mountRows = (shape: Shape, skipping: boolean) => {
  const rows = shape === "scroller in a rounded panel" ? 40 : 16
  const renderer = new TestRenderer({ width: 400, height: 400 })
  renderer.setRetainPlanning(skipping)
  renderer.setRetainEnabled(skipping)
  // The counters are judged on frames that skip, which a run under GPUIX_RETAIN_VERIFY does not make.
  renderer.setRetainVerify(false)
  renderer.clockPause()
  const rounded = { borderRadius: RADIUS, overflow: "hidden", backgroundColor: "#eeeeee" }
  const parent = shape === "scroller in a rounded panel" ? SCROLLER : 3
  const batch: unknown[] = [
    ["createElement", 1, "div"],
    ["setRoot", 1],
    ["setStyle", 1, { width: 400, height: 400 }],
  ]
  if (shape === "scroller in a rounded panel") {
    batch.push(
      ["createElement", 3, "div"],
      ["appendChild", 1, 3],
      ["setStyle", 3, { width: SIZE, height: SIZE, ...rounded }],
      ["createElement", SCROLLER, "div"],
      ["appendChild", 3, SCROLLER],
      ["setStyle", SCROLLER, { width: SIZE, height: SIZE, overflow: "auto" }],
    )
  } else {
    batch.push(
      ["createElement", SCROLLER, "div"],
      ["appendChild", 1, SCROLLER],
      ["setStyle", SCROLLER, { width: SIZE, height: SIZE, overflow: "auto" }],
      ["createElement", 3, "div"],
      ["appendChild", SCROLLER, 3],
      ["setStyle", 3, { width: SIZE - 2 * CARD_MARGIN, marginTop: CARD_MARGIN, marginLeft: CARD_MARGIN, ...rounded }],
      // A block-end margin does not extend what the scroller scrolls, so the room below the card is a box.
      ["createElement", 4, "div"],
      ["appendChild", SCROLLER, 4],
      ["setStyle", 4, { height: CARD_ROOM_BELOW, flexShrink: 0 }],
    )
  }
  for (let index = 0; index < rows; index++) {
    const row = rowId(index)
    batch.push(
      ["createElement", row, "div"],
      ["appendChild", parent, row],
      ["setStyle", row, { height: ROW_HEIGHT, flexShrink: 0, backgroundColor: index % 2 ? "#ddccdd" : "#ccddcc" }],
      ["createElement", row + 1, "div"],
      ["appendChild", row, row + 1],
      ["setStyle", row + 1, { width: 100, height: ROW_HEIGHT, backgroundColor: "#335577" }],
      ["createElement", row + 2, "#text"],
      ["setText", row + 2, `row ${index}`],
      ["appendChild", row + 1, row + 2],
    )
  }
  renderer.applyBatch(encodeWireBatchForTest(batch))
  for (let frame = 0; frame < 4; frame++) renderer.flush()
  return renderer
}

// Draws the rows where they are recorded, before the scroll that moves them.
const settle = (renderer: TestRenderer, from: number) => {
  renderer.scrollTo(SCROLLER, undefined, from)
  renderer.flush()
  renderer.flush()
}

// `captureScreenshot` refreshes the window and builds the frame whole, which is not the frame the scroll left.
const picture = (renderer: TestRenderer) => {
  const path = join(mkdtempSync(join(tmpdir(), "retain-rounded-")), "page.png")
  renderer.captureShownFrame(path)
  return readFileSync(path)
}

const clip = (counters: { nonRelocatable: string }) => {
  const reasons = JSON.parse(counters.nonRelocatable) as Record<string, number>
  return reasons.Clip === undefined ? 0 : reasons.Clip
}

// The counters belong to the process, so the measured run ends before the oracle (retention off) is mounted.
const play = (shape: Shape, skipping: boolean, from: number, steps: number) => {
  const renderer = mountRows(shape, skipping)
  settle(renderer, from)
  const before = renderer.getRetainedCounters()
  for (let step = 0; step < steps; step++) {
    renderer.dispatchScrollWheel(100, 100, 0, 37)
    renderer.flush()
  }
  return { before, after: renderer.getRetainedCounters(), picture: picture(renderer) }
}

// The card is 640 px tall, more than two viewports of 300, so its rows are the roots and not the card. With room above and below it,
// one 37 px step from 0 leaves its top corners in the scroller and uncut by it, and one from 420 its bottom ones. The panel's own
// corners are in view on every step.
const cases = [
  ["scroller in a rounded panel", 0, 4],
  ["rounded card in a scroller", 0, 1],
  ["rounded card in a scroller", 420, 1],
] as const

describe.skipIf(!hasNativeTestRenderer)("rows under a rounded content mask that a scroll moves", () => {
  it.each(cases)("moves the rows of a %s that clear the corners and builds the ones that touch one (from %d)", (shape, from, steps) => {
    const kept = play(shape, true, from, steps)
    const moved = kept.after.relocations - kept.before.relocations
    const refused = clip(kept.after) - clip(kept.before)
    expect(moved).toBeGreaterThan(0)
    // Before a rounded mask was judged by its corners, every row under it was refused: `moved` was 0.
    expect(refused).toBeLessThan(moved)
    const built = play(shape, false, from, steps)
    expect(kept.picture.equals(built.picture)).toBe(true)
  })

  // A frame that only replays is built a second time under the verifier and shown as that build, whose recordings cannot be
  // moved. So each step is drawn twice: the verifier off for the frame that records the rows, on for the one that moves them.
  it.each(cases)("agrees with a build of the frame under the verifier for a %s (from %d)", (shape, from, steps) => {
    const renderer = mountRows(shape, true)
    settle(renderer, from)
    const before = renderer.getRetainedCounters()
    for (let step = 1; step <= steps; step++) {
      renderer.setRetainVerify(false)
      renderer.scrollTo(SCROLLER, undefined, from + 37 * step - 18)
      renderer.flush()
      renderer.setRetainVerify(true)
      renderer.scrollTo(SCROLLER, undefined, from + 37 * step)
      renderer.flush()
    }
    const after = renderer.getRetainedCounters()
    expect(renderer.getRetainMismatches()).toEqual([])
    expect(after.mismatches).toBe(0)
    expect(after.relocations - before.relocations).toBeGreaterThan(0)
  })
})
