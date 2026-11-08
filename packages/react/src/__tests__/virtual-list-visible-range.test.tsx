import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import type { DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

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

type Range = [number | undefined, number | undefined]

/** Viewport 100 over rows of 40: what a wheel to each offset in turn reports, and what a write of the offset reports. */
const OFFSETS = [5, 35, 36, 100, 330, 100, 0, 0, 5]

function wheelRanges(): Range[] {
  const { render, renderer, unmount } = createTestRoot()
  try {
    const ranges: Range[] = []
    render(listWith((event) => ranges.push([event.startIndex, event.endIndex])))
    renderer.dispatchNativeEvents()
    let at = 0
    for (const offset of OFFSETS) {
      if (offset !== at) renderer.nativeSimulateScrollWheel(100, 50, 0, offset - at)
      renderer.dispatchNativeEvents()
      at = offset
    }
    return ranges
  } finally {
    unmount()
  }
}

function writtenRanges(write: (renderer: TestRenderer, list: number, offset: number) => void): Range[] {
  const { render, renderer, unmount } = createTestRoot()
  try {
    const ranges: Range[] = []
    render(listWith((event) => ranges.push([event.startIndex, event.endIndex])))
    renderer.dispatchNativeEvents()
    const list = renderer.findByTestId("list")!.id
    for (const offset of OFFSETS) {
      write(renderer, list, offset)
      renderer.drawFrame()
      renderer.dispatchNativeEvents()
    }
    return ranges
  } finally {
    unmount()
  }
}

describeNative("onVisibleRange of a programmatic scroll", () => {
  it("reports the range a wheel to the same offset reports, once", () => {
    const wheeled = wheelRanges()
    expect(wheeled).toEqual([[0, 3], [0, 4], [2, 5], [8, 11], [2, 5], [0, 3]])
    const written = writtenRanges((renderer, list, offset) => renderer.scrollTo(list, 0, offset))
    expect(written).toEqual(wheeled)
  })

  it("is reported once for a write to where the list is", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      const ranges: Range[] = []
      render(listWith((event) => ranges.push([event.startIndex, event.endIndex])))
      renderer.dispatchNativeEvents()
      const list = renderer.findByTestId("list")!.id
      renderer.scrollTo(list, 0, 100)
      renderer.drawFrame()
      renderer.dispatchNativeEvents()
      expect(ranges).toEqual([[2, 5]])
      renderer.scrollTo(list, undefined, 100)
      renderer.dispatchNativeEvents()
      expect(ranges, "a write to where it is moves nothing and reports nothing").toEqual([[2, 5]])
    } finally {
      unmount()
    }
  })

  it("a write and a wheel to the same rows report once", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      const ranges: Range[] = []
      render(listWith((event) => ranges.push([event.startIndex, event.endIndex])))
      renderer.dispatchNativeEvents()
      const list = renderer.findByTestId("list")!.id
      renderer.scrollTo(list, 0, 100)
      renderer.drawFrame()
      renderer.nativeSimulateScrollWheel(100, 50, 0, -1)
      renderer.dispatchNativeEvents()
      expect(ranges).toEqual([[2, 5]])
    } finally {
      unmount()
    }
  })

  it("scrollToItem reports the rows that show, not the item and the next", () => {
    const { render, renderer, unmount } = createTestRoot()
    try {
      const ranges: Range[] = []
      render(listWith((event) => ranges.push([event.startIndex, event.endIndex])))
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      renderer.scrollToItem(renderer.findByTestId("list")!.id, 5)
      expect(ranges).toEqual([[5, 8]])
    } finally {
      unmount()
    }
  })
})

const COUNT = 200
const WINDOW_ROW = 40
const WINDOW_VIEW = 300
const WINDOW = 60
const WINDOW_STEP = 10
const WINDOW_LEAD = 15
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "visible-range-"))

const rowColor = (index: number) => `rgb(${(index * 37) % 256}, ${(index * 91) % 256}, ${(index * 53) % 256})`

function Row({ index }: { index: number }) {
  return (
    <div testId={`row-${index}`} style={{ width: 150, height: WINDOW_ROW, flexShrink: 0, backgroundColor: rowColor(index) }}>
      <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
    </div>
  )
}

/** The rows of a window the app moves from `onVisibleRange`, as ghia-bench's mailbox does. */
function Windowed({ onRange }: { onRange: (event: DomEvent) => void }) {
  const [start, setStart] = useState(0)
  const indices = Array.from({ length: WINDOW }, (_, offset) => start + offset).filter((index) => index < COUNT)
  return (
    <virtual-list
      testId="list"
      itemCount={COUNT}
      windowStart={start}
      estimatedItemHeight={WINDOW_ROW}
      style={{ width: 200, height: WINDOW_VIEW, scrollbarWidth: "none" }}
      onVisibleRange={(event) => {
        onRange(event)
        setStart(Math.max(0, Math.floor(((event.startIndex ?? 0) - WINDOW_LEAD) / WINDOW_STEP) * WINDOW_STEP))
      }}
    >
      {indices.map((index) => (
        <Row key={index} index={index} />
      ))}
    </virtual-list>
  )
}

function Whole() {
  return (
    <virtual-list testId="list" itemCount={COUNT} estimatedItemHeight={WINDOW_ROW} style={{ width: 200, height: WINDOW_VIEW, scrollbarWidth: "none" }}>
      {Array.from({ length: COUNT }, (_, index) => (
        <Row key={index} index={index} />
      ))}
    </virtual-list>
  )
}

/** The frame that was drawn last as it is. */
function picture(renderer: TestRenderer, name: string): string {
  const file = path.join(shots, `${process.pid}-${name}.png`)
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

/** Where a key that brings row `index` in at the bottom scrolls the list to. */
const revealing = (index: number) => Math.max(0, (index + 1) * WINDOW_ROW - WINDOW_VIEW)

const KEYS = 120
const SHOWN = [10, 52, 70, 119]

describeNative("a list windowed from onVisibleRange under keyboard navigation", () => {
  it("moves its window with the rows, paints them, and reports each range once", () => {
    const ranges: Range[] = []
    const shown = new Map<number, string>()
    const { render, renderer, unmount } = createTestRoot({ width: 300, height: 400 })
    try {
      renderer.setA11yActive(false)
      render(<Windowed onRange={(event) => ranges.push([event.startIndex, event.endIndex])} />)
      renderer.drawFrame()
      renderer.dispatchNativeEvents()
      const list = renderer.findByTestId("list")!.id
      for (let key = 1; key <= KEYS; key++) {
        renderer.scrollTo(list, 0, revealing(key))
        renderer.drawFrame()
        renderer.dispatchNativeEvents()
        renderer.drawFrame()
        expect(renderer.findByTestId(`row-${key}`), `row ${key} is mounted at key ${key}`).not.toBeNull()
        if (SHOWN.includes(key)) shown.set(key, picture(renderer, `windowed-${key}`))
      }
    } finally {
      unmount()
    }

    const expected: Range[] = []
    let at = 0
    for (let key = 1; key <= KEYS; key++) {
      const offset = revealing(key)
      if (offset === at) continue
      at = offset
      const range: Range = [Math.floor(offset / WINDOW_ROW), Math.min(COUNT, Math.ceil((offset + WINDOW_VIEW) / WINDOW_ROW))]
      if (JSON.stringify(expected[expected.length - 1]) !== JSON.stringify(range)) expected.push(range)
    }
    expect(ranges).toEqual(expected)

    const reference = createTestRoot({ width: 300, height: 400 })
    try {
      reference.renderer.setA11yActive(false)
      reference.render(<Whole />)
      reference.renderer.drawFrame()
      const list = reference.renderer.findByTestId("list")!.id
      const blank = picture(reference.renderer, "whole-0")
      for (const key of SHOWN) {
        reference.renderer.scrollTo(list, 0, revealing(key))
        reference.renderer.drawFrame()
        const whole = picture(reference.renderer, `whole-${key}`)
        expect(whole, `the frame at key ${key} shows rows`).not.toBe(blank)
        expect(shown.get(key), `the windowed list at key ${key} is the list with every row`).toBe(whole)
      }
    } finally {
      reference.unmount()
    }
  })
})
