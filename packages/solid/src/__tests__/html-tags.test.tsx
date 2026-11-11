/// HTML tags are host elements in Solid as in React: `<p>` mounts, lays out with its default margins, and an inline tag
/// runs on in the paragraph of its parent. The Chrome oracle is read by the React suite (`html-tags.test.tsx`).
import fs from "fs"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const SQUARE_FONT = fs.readFileSync(new URL("../../../react/src/__tests__/fixtures/gpuix-test-square.ttf", import.meta.url))
/** GpuixTestSquare has no space: the fallback font's is 569/2048 em. */
const SPACE = (569 / 2048) * 20
const PAGE = { position: "absolute", left: 0, top: 0, width: 400, fontFamily: "GpuixTestSquare", fontSize: 20, lineHeight: 1, color: "#000000" } as const

describe.skipIf(!hasNativeTestRenderer)("Solid HTML tags", () => {
  it("mounts a paragraph with its default margins and a heading", () => {
    const app = createTestRoot({ width: 800, height: 600 })
    try {
      app.renderer.registerFont(SQUARE_FONT)
      app.render(() => (
        <div style={PAGE}>
          <h1 testId="h1">AA</h1>
          <p testId="p">AA</p>
        </div>
      ))
      const bounds = (id: string) => app.renderer.getElementBounds(app.renderer.findByTestId(id)!.id)!
      expect(bounds("h1").y).toBeCloseTo(26.8, 0)
      expect(bounds("h1").height).toBe(40)
      expect(bounds("p").y).toBeCloseTo(93.6, 0)
    } finally {
      app.unmount()
    }
  })

  it("runs an inline tag on in the paragraph of its parent", () => {
    const app = createTestRoot({ width: 800, height: 600 })
    try {
      app.renderer.registerFont(SQUARE_FONT)
      app.render(() => (
        <div style={PAGE}>
          <p testId="p">
            AA <strong testId="strong">AA</strong> <a testId="a">AA</a>
          </p>
        </div>
      ))
      const bounds = (id: string) => app.renderer.getElementBounds(app.renderer.findByTestId(id)!.id)!
      expect(bounds("p").height).toBe(20)
      expect(bounds("strong").x).toBeCloseTo(40 + SPACE, 1)
      expect(bounds("a").x).toBeCloseTo(80 + 2 * SPACE, 1)
    } finally {
      app.unmount()
    }
  })
})
