import { describe, expect, it, vi } from "vitest"
import { createRoot } from "../root.js"
import { TestRenderer, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("the roots of one renderer (Solid)", () => {
  it("refuses a second simultaneous root on one renderer, and the live root keeps its keys", () => {
    const renderer = new TestRenderer()
    const onFirstKey = vi.fn()
    const first = createRoot(renderer, { onKeyDown: onFirstKey })

    try {
      first.render(() => <div style={{ width: 100, height: 100 }}>first</div>)
      renderer.flush()
      const rootId = renderer.getRoot()!.id

      expect(() => createRoot(renderer)).toThrowErrorMatchingInlineSnapshot(
        `[Error: This renderer already drives a mounted GPUIX root. One renderer owns one window, one native root id, and one event map, so a second root would silently take both over. Unmount the first root first.]`
      )

      // The refused root queued no `<html>` or `setRoot`: the flush `simulateKeystrokes` runs first sends nothing over the live tree.
      renderer.simulateKeystrokes("Tab")
      expect(onFirstKey).toHaveBeenCalledTimes(1)
      expect(renderer.getRoot()!.id).toBe(rootId)
    } finally {
      first.unmount()
    }
  })
})
