/**
 * The rows of a `<virtual-list>` that have a `::before` box: when a row leaves the viewport the
 * sweep of what it recorded (`Retain::forget_unseen_rows`) takes the box with it, since a box is a
 * child of its row for layout (`layout_children`) and not of `children`. Left behind, the box's
 * record says it was built as it is when the row comes back with another box.
 */
import { describe, expect, it } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

const ROWS = 60
const ROW_HEIGHT = 40
const rowId = (index: number) => 1000 + index * 10

const mountList = (verify: boolean) => {
  const renderer = new TestRenderer({ width: 300, height: 300 })
  renderer.setRetainPlanning(true)
  renderer.setRetainEnabled(true)
  renderer.setRetainVerify(verify)
  renderer.clockPause()
  const batch: unknown[] = [
    ["createElement", 1, "div"],
    ["setRoot", 1],
    ["setStyle", 1, { width: 300, height: 300 }],
    ["setStyleSheet", 900, `.item { position: relative } .item::before { content: attr(data-mark); position: absolute; left: 4px; top: 4px }`],
    ["setAdoptedStyleSheets", [900]],
    ["createElement", 2, "virtual-list"],
    ["appendChild", 1, 2],
    ["setStyle", 2, { width: 300, height: 300 }],
  ]
  for (let index = 0; index < ROWS; index++) {
    const row = rowId(index)
    batch.push(
      ["createElement", row, "div"],
      ["appendChild", 2, row],
      ["setAttribute", row, "class", "item"],
      ["setAttribute", row, "data-mark", "\u2022"],
      ["setStyle", row, { height: ROW_HEIGHT, flexShrink: 0, display: "flex", flexDirection: "row" }],
      ["createElement", row + 1, "div"],
      ["appendChild", row, row + 1],
      ["setStyle", row + 1, { width: 100, height: ROW_HEIGHT, backgroundColor: "#335577" }],
      ["createElement", row + 3, "#text"],
      ["setText", row + 3, `row ${index}`],
      ["appendChild", row + 1, row + 3],
    )
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

describe.skipIf(!hasNativeTestRenderer)("generated boxes in the rows of a virtual list", () => {
  it("agrees with a build of the frame when a row with a ::before comes back", () => {
    const renderer = mountList(true)
    for (let frame = 0; frame < 3; frame++) renderer.flush()
    renderer.scrollTo(2, undefined, 40 * ROW_HEIGHT)
    frames(renderer, 3)
    expect(renderer.getElementBounds(rowId(0))).toBeFalsy()
    renderer.applyBatch(encodeWireBatchForTest([["setAttribute", rowId(0), "data-mark", "*"]]))
    renderer.scrollTo(2, undefined, 0)
    frames(renderer, 3)
    expect(renderer.getElementBounds(rowId(0))).toBeTruthy()
    expect(renderer.getRetainMismatches()).toEqual([])
    expect(renderer.getRetainedCounters().mismatches).toBe(0)
    renderer.dispose()
  })

  it("keeps no record of the boxes of rows that left", () => {
    const renderer = mountList(false)
    const records = () => (renderer as unknown as { native: { getRetainRecordCounts(): number[] } }).native.getRetainRecordCounts()[0]
    frames(renderer, 3)
    const start = records()
    let most = start
    for (let top = 0; top < ROWS - 8; top += 4) {
      renderer.scrollTo(2, undefined, top * ROW_HEIGHT)
      frames(renderer, 2)
      most = Math.max(most, records())
    }
    expect(most, "a record for every box ever built grows with the rows scrolled through").toBeLessThan(start * 2)
    renderer.dispose()
  })
})
