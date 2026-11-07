import { describe, expect, it } from "vitest"
import type { DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ROW = 40
const VIEWPORT = 100

function listWith(onVisibleRange: (event: DomEvent) => void) {
  return (
    <virtual-list
      testId="list"
      itemCount={20}
      estimatedItemHeight={ROW}
      overdraw={0}
      style={{ width: 200, height: VIEWPORT }}
      onVisibleRange={onVisibleRange}
    >
      {Array.from({ length: 20 }, (_, index) => (
        <div key={index} style={{ height: ROW, flexShrink: 0 }}>
          <text>{`row-${index}`}</text>
        </div>
      ))}
    </virtual-list>
  )
}

/** Viewport 100 over rows of 40: the range changes at offsets 20 (a fourth row shows), 40, 60. */
describeNative("onVisibleRange", () => {
  const wheel = (renderer: { nativeSimulateScrollWheel(x: number, y: number, dx: number, dy: number): void; dispatchNativeEvents(): void }, dy: number) => {
    renderer.nativeSimulateScrollWheel(100, 50, 0, dy)
    renderer.dispatchNativeEvents()
  }

  it("fires when the visible range changes, not on every scroll event", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      const ranges: unknown[] = []
      render(listWith((event) => ranges.push([event.startIndex, event.endIndex])))
      renderer.dispatchNativeEvents()
      expect(ranges, "a first paint is not a scroll").toEqual([])

      wheel(renderer, 5)
      expect(ranges, "the first scroll reports the range").toEqual([[0, 3]])

      wheel(renderer, 5)
      wheel(renderer, 5)
      expect(ranges, "15 px in, the same rows show").toEqual([[0, 3]])

      wheel(renderer, 10)
      expect(ranges, "at 25 px a fourth row shows").toEqual([[0, 3], [0, 4]])

      wheel(renderer, 20)
      expect(ranges, "at 45 px the first row has left").toEqual([[0, 3], [0, 4], [1, 4]])
    } finally {
      unmount()
    }
  })

  it("reports a range again after it has changed and come back", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      const ranges: unknown[] = []
      render(listWith((event) => ranges.push([event.startIndex, event.endIndex])))
      renderer.dispatchNativeEvents()

      wheel(renderer, 5)
      wheel(renderer, 30)
      wheel(renderer, -30)
      expect(ranges).toEqual([[0, 3], [0, 4], [0, 3]])
    } finally {
      unmount()
    }
  })

  it("keeps what it last reported through a render", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      const ranges: unknown[] = []
      const onVisibleRange = (event: DomEvent) => ranges.push([event.startIndex, event.endIndex])
      render(listWith(onVisibleRange))
      renderer.dispatchNativeEvents()
      wheel(renderer, 5)
      render(listWith(onVisibleRange))
      wheel(renderer, 5)
      expect(ranges).toEqual([[0, 3]])
    } finally {
      unmount()
    }
  })
})
