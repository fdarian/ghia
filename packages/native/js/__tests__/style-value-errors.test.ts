import { describe, expect, it } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("a style value that does not parse", () => {
  function mount(style: Record<string, unknown>) {
    const renderer = new TestRenderer({ width: 200, height: 200 })
    renderer.applyBatch(
      encodeWireBatchForTest([
        ["createElement", 1, "div"],
        ["setRoot", 1],
        ["setStyle", 1, style],
      ])
    )
    renderer.flush()
    return renderer
  }

  it("drops only its declaration, so the element keeps the rest", () => {
    const renderer = mount({
      border: 0,
      height: "inherit",
      width: "wide",
      backgroundColor: "red",
    })
    try {
      const style = renderer.getElement(1)?.style
      expect(style?.backgroundColor).toBe("red")
      expect(style?.border).toBe("0")
      expect(style).not.toHaveProperty("height")
      expect(style).not.toHaveProperty("width")
    } finally {
      renderer.dispose()
    }
  })

  it("still rejects a style that is not an object", () => {
    const renderer = new TestRenderer({ width: 200, height: 200 })
    try {
      expect(() =>
        renderer.applyBatch(
          encodeWireBatchForTest([
            ["createElement", 1, "div"],
            ["setStyle", 1, 5],
          ])
        )
      ).toThrow("setStyle parse error")
    } finally {
      renderer.dispose()
    }
  })
})
