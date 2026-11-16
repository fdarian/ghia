import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

const ROWS = 40
const ROW_HEIGHT = 40
const SIZE = 300
const RADIUS = 24
const SCROLLER = 2

type Shape = "scroller in a rounded panel" | "rounded card in a scroller"

const rowId = (index: number) => 1000 + index * 10

// Rows of three elements (the row, a box, a text), each a retained root, in a scroller that is a plain rectangle.
// The rounded mask is the panel the scroller fills, or a card that holds the rows and scrolls with them.
const mountRows = (shape: Shape, skipping: boolean) => {
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
      ["setStyle", 3, { width: SIZE, ...rounded }],
    )
  }
  for (let index = 0; index < ROWS; index++) {
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

const wheel = (renderer: TestRenderer, from: number) => {
  renderer.scrollTo(SCROLLER, undefined, from)
  renderer.flush()
  renderer.flush()
  for (let step = 0; step < 4; step++) {
    renderer.dispatchScrollWheel(100, 100, 0, 37)
    renderer.flush()
  }
}

const picture = (renderer: TestRenderer) => {
  const path = join(mkdtempSync(join(tmpdir(), "retain-rounded-")), "page.png")
  renderer.captureScreenshot(path)
  return readFileSync(path)
}

const clip = (counters: { nonRelocatable: string }) => {
  const reasons = JSON.parse(counters.nonRelocatable) as Record<string, number>
  return reasons.Clip === undefined ? 0 : reasons.Clip
}

// The counters belong to the process, so the measured run ends before the oracle (retention off) is mounted.
const play = (shape: Shape, skipping: boolean, from: number) => {
  const renderer = mountRows(shape, skipping)
  const before = renderer.getRetainedCounters()
  wheel(renderer, from)
  return { before, after: renderer.getRetainedCounters(), picture: picture(renderer) }
}

const cases = [
  ["scroller in a rounded panel", 0],
  // The card is as tall as all its rows, so its corners are far from the 300 px the scroller shows.
  ["rounded card in a scroller", 400],
] as const

describe.skipIf(!hasNativeTestRenderer)("rows under a rounded content mask that a scroll moves", () => {
  it.each(cases)("moves the rows of a %s that clear the corners and builds the ones that touch one", (shape, from) => {
    const kept = play(shape, true, from)
    const moved = kept.after.relocations - kept.before.relocations
    const refused = clip(kept.after) - clip(kept.before)
    expect(moved).toBeGreaterThan(0)
    // Before a rounded mask was judged by its corners, every row under it was refused: `moved` was 0.
    expect(refused).toBeLessThan(moved)
    if (shape === "rounded card in a scroller") expect(refused).toBe(0)
    const built = play(shape, false, from)
    expect(kept.picture.equals(built.picture)).toBe(true)
  })

  it.each(cases)("agrees with a build of the frame under the verifier for a %s", (shape, from) => {
    const renderer = mountRows(shape, true)
    renderer.setRetainVerify(true)
    for (let frame = 0; frame < 3; frame++) renderer.flush()
    wheel(renderer, from)
    expect(renderer.getRetainMismatches()).toEqual([])
    expect(renderer.getRetainedCounters().mismatches).toBe(0)
  })
})
