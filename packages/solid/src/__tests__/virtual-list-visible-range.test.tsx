/**
 * `onVisibleRange` of a list fires for a write to its scroll position as it does for a wheel (scroll.md, "onVisibleRange fires when the
 * visible range changes"): the range is the one a wheel to the same offset reports, a range is reported once, and an app that moves a
 * window of rows from it follows a run of keys that scroll the list with `scrollTo`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import type { DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Range = [number | undefined, number | undefined]

const ROW = 40
const VIEWPORT = 100

function list(onVisibleRange: (event: DomEvent) => void) {
  return () => (
    <virtual-list
      testId="list"
      itemCount={20}
      estimatedItemHeight={ROW}
      overdraw={0}
      style={{ width: 200, height: VIEWPORT }}
      onVisibleRange={onVisibleRange}
    >
      <For each={Array.from({ length: 20 }, (_, index) => index)}>
        {(index) => (
          <div style={{ height: ROW, flexShrink: 0 }}>
            <div>{`row-${index}`}</div>
          </div>
        )}
      </For>
    </virtual-list>
  )
}

/** Viewport 100 over rows of 40: what a wheel to each offset in turn reports, and what a write of the offset reports. */
const OFFSETS = [5, 35, 36, 100, 330, 100, 0, 0, 5]

function run(step: (renderer: TestRenderer, list: number, at: number, offset: number) => void): Range[] {
  const app = createTestRoot()
  try {
    const ranges: Range[] = []
    app.render(list((event) => ranges.push([event.startIndex, event.endIndex])))
    app.renderer.dispatchNativeEvents()
    const id = app.renderer.findByTestId("list")!.id
    let at = 0
    for (const offset of OFFSETS) {
      step(app.renderer, id, at, offset)
      app.renderer.dispatchNativeEvents()
      at = offset
    }
    return ranges
  } finally {
    app.unmount()
  }
}

describeNative("onVisibleRange of a programmatic scroll", () => {
  it("reports the range a wheel to the same offset reports, once", () => {
    const wheeled = run((renderer, _list, at, offset) => {
      if (offset !== at) renderer.nativeSimulateScrollWheel(100, 50, 0, offset - at)
    })
    expect(wheeled).toEqual([[0, 3], [0, 4], [2, 5], [8, 11], [2, 5], [0, 3]])
    const written = run((renderer, id, _at, offset) => {
      renderer.scrollTo(id, 0, offset)
      renderer.drawFrame()
    })
    expect(written).toEqual(wheeled)
  })

  it("reports nothing for a write to where the list is, and once for a wheel and a write to the same rows", () => {
    const app = createTestRoot()
    try {
      const ranges: Range[] = []
      app.render(list((event) => ranges.push([event.startIndex, event.endIndex])))
      app.renderer.dispatchNativeEvents()
      const id = app.renderer.findByTestId("list")!.id
      app.renderer.scrollTo(id, 0, 100)
      app.renderer.drawFrame()
      app.renderer.scrollTo(id, undefined, 100)
      app.renderer.nativeSimulateScrollWheel(100, 50, 0, -1)
      app.renderer.dispatchNativeEvents()
      expect(ranges).toEqual([[2, 5]])
    } finally {
      app.unmount()
    }
  })

  it("scrollToItem reports the rows that show, not the item and the next", () => {
    const app = createTestRoot()
    try {
      const ranges: Range[] = []
      app.render(list((event) => ranges.push([event.startIndex, event.endIndex])))
      app.renderer.dispatchNativeEvents()
      app.renderer.drawFrame()
      app.renderer.scrollToItem(app.renderer.findByTestId("list")!.id, 5)
      app.renderer.drawFrame()
      app.renderer.dispatchNativeEvents()
      expect(ranges).toEqual([[5, 8]])
    } finally {
      app.unmount()
    }
  })
})

const ROWS = 20
const LAST_OFFSET = ROWS * ROW - VIEWPORT

/** `exact` rows fix their border box, so the list is told their size; the others are measured and the list guesses their height first. */
function sizedList(exact: boolean, onVisibleRange: (event: DomEvent) => void, alignment?: "bottom") {
  return () => (
    <virtual-list
      testId="list"
      itemCount={ROWS}
      estimatedItemHeight={exact ? ROW : 25}
      overdraw={0}
      alignment={alignment}
      style={{ width: 200, height: VIEWPORT }}
      onVisibleRange={onVisibleRange}
    >
      <For each={Array.from({ length: ROWS }, (_, index) => index)}>
        {(index) => (
          <div testId={`row-${index}`} style={exact ? { height: ROW, flexShrink: 0 } : undefined}>
            {exact ? <div>{`row-${index}`}</div> : <div style={{ height: ROW, flexShrink: 0 }} />}
          </div>
        )}
      </For>
    </virtual-list>
  )
}

/** The rows a frame paints in the list, from their boxes. */
function paintedRange(renderer: TestRenderer): Range {
  const box = renderer.getElementBounds(renderer.findByTestId("list")!.id)!
  const shown: number[] = []
  for (let index = 0; index < ROWS; index++) {
    const row = renderer.getElementBounds(renderer.findByTestId(`row-${index}`)!.id)
    if (row && row.y < box.y + box.height && row.y + row.height > box.y) shown.push(index)
  }
  return [shown[0], shown[shown.length - 1] + 1]
}

describeNative("scrollToItem reports the rows the list shows after the layout holds its offset", () => {
  const TARGETS = [ROWS - 1, ROWS - 2, ROWS - 3, ROWS - 4, 10, 1, 0, ROWS, ROWS + 7]

  for (const exact of [true, false]) {
    for (const target of TARGETS) {
      it(`${exact ? "exact" : "estimated"} rows, row ${target}: the range is the rows painted (and, for exact rows, the one a wheel to the offset reports), once`, () => {
        const scrolled = createTestRoot()
        let painted: Range
        let offset: number
        const ranges: Range[] = []
        try {
          scrolled.render(sizedList(exact, (event) => ranges.push([event.startIndex, event.endIndex])))
          scrolled.renderer.dispatchNativeEvents()
          scrolled.renderer.drawFrame()
          scrolled.renderer.scrollToItem(scrolled.renderer.findByTestId("list")!.id, target)
          scrolled.renderer.drawFrame()
          scrolled.renderer.dispatchNativeEvents()
          scrolled.renderer.drawFrame()
          scrolled.renderer.dispatchNativeEvents()
          painted = paintedRange(scrolled.renderer)
          offset = scrolled.renderer.getScrollOffset(scrolled.renderer.findByTestId("list")!.id)![1]
        } finally {
          scrolled.unmount()
        }
        if (exact) {
          const expectedOffset = Math.min(LAST_OFFSET, target * ROW)
          expect(offset).toBe(expectedOffset)
          const wheeled: Range[] = []
          const reference = createTestRoot()
          try {
            reference.render(sizedList(exact, (event) => wheeled.push([event.startIndex, event.endIndex])))
            reference.renderer.dispatchNativeEvents()
            reference.renderer.drawFrame()
            reference.renderer.nativeSimulateScrollWheel(100, 50, 0, offset)
            reference.renderer.dispatchNativeEvents()
          } finally {
            reference.unmount()
          }
          if (expectedOffset > 0) expect(ranges, "the range a wheel to the same offset reports").toEqual(wheeled)
        }
        expect(ranges, "one event").toHaveLength(1)
        expect(ranges[0][0], "the first row painted").toBe(painted[0])
        expect(Math.min(ranges[0][1]!, ROWS), "the last row painted").toBe(painted[1])
      })
    }
  }

  for (const alignment of [undefined, "bottom"] as const) {
    it(`${alignment ?? "top"}-aligned list, scrollIntoView of the last row at the end and the start: the range is the rows painted`, () => {
      for (const block of ["end", "start"] as const) {
        const app = createTestRoot()
        try {
          const ranges: Range[] = []
          app.render(sizedList(true, (event) => ranges.push([event.startIndex, event.endIndex]), alignment))
          app.renderer.dispatchNativeEvents()
          app.renderer.drawFrame()
          app.renderer.scrollTo(app.renderer.findByTestId("list")!.id, 0, 100)
          app.renderer.drawFrame()
          app.renderer.dispatchNativeEvents()
          ranges.length = 0
          app.renderer.scrollIntoView(app.renderer.findByTestId(`row-${ROWS - 1}`)!.id, block)
          app.renderer.drawFrame()
          app.renderer.drawFrame()
          app.renderer.dispatchNativeEvents()
          const painted = paintedRange(app.renderer)
          expect(ranges, `block ${block}: one event`).toHaveLength(1)
          expect([ranges[0][0], Math.min(ranges[0][1]!, ROWS)], `block ${block}: the rows painted`).toEqual(painted)
        } finally {
          app.unmount()
        }
      }
    })
  }

  it("scrollToItem to the last rows, which all rest at the same offset, reports once", () => {
    const app = createTestRoot()
    try {
      const ranges: Range[] = []
      app.render(sizedList(true, (event) => ranges.push([event.startIndex, event.endIndex])))
      app.renderer.dispatchNativeEvents()
      app.renderer.drawFrame()
      const id = app.renderer.findByTestId("list")!.id
      for (const target of [ROWS - 1, ROWS - 1, ROWS - 2, ROWS - 1]) {
        app.renderer.scrollToItem(id, target)
        app.renderer.drawFrame()
        app.renderer.dispatchNativeEvents()
      }
      expect(ranges).toHaveLength(1)
    } finally {
      app.unmount()
    }
  })
})

/** The thumb of a list this wide is in the column 6 px from its right edge. */
const BAR_X = 194

type Pointer = { move: number } | { page: number }

/**
 * A wheel shows the bar, then the thumb is held at `grab` and the pointer goes to each `y`, and a press on the track pages. After
 * every step the range reported is the rows painted and the one a wheel to the offset reports, and none comes when the rows stay
 * the same. The rows are exact: the thumb of estimated rows moves over the extent the list guesses.
 */
function dragged(alignment: "bottom" | undefined, wheel: number, grab: number, steps: Pointer[]) {
  const app = createTestRoot()
  try {
    const renderer = app.renderer
    const ranges: Range[] = []
    app.render(sizedList(true, (event) => ranges.push([event.startIndex, event.endIndex]), alignment))
    renderer.dispatchNativeEvents()
    renderer.drawFrame()
    const list = renderer.findByTestId("list")!.id
    renderer.nativeSimulateScrollWheel(100, 50, 0, wheel)
    renderer.drawFrame()
    renderer.dispatchNativeEvents()
    expect(ranges, "the wheel that shows the bar").toHaveLength(1)

    const rowsAt = (offset: number): Range => [Math.floor(offset / ROW), Math.min(ROWS, Math.ceil((offset + VIEWPORT) / ROW))]
    let last = ranges[0]
    let reported = 0
    const check = (step: string) => {
      renderer.drawFrame()
      renderer.dispatchNativeEvents()
      const offset = renderer.getScrollOffset(list)![1]
      const expected = paintedRange(renderer)
      expect(expected, `${step}: at ${offset}, the rows the offset shows`).toEqual(rowsAt(offset))
      const events = ranges.splice(1).map((range): Range => [range[0], Math.min(range[1]!, ROWS)])
      if (JSON.stringify(expected) === JSON.stringify(last)) {
        expect(events, `${step}: at ${offset}, the same rows`).toEqual([])
      } else {
        expect(events, `${step}: at ${offset}`).toEqual([expected])
        reported++
      }
      last = expected
    }
    renderer.nativeSimulateMouseMove(BAR_X, grab)
    renderer.nativeSimulateMouseDown(BAR_X, grab)
    for (const step of steps) {
      if ("move" in step) {
        renderer.nativeSimulateMouseMove(BAR_X, step.move)
        check(`drag to ${step.move}`)
      } else {
        renderer.nativeSimulateMouseUp(BAR_X, step.page)
        renderer.nativeSimulateMouseMove(BAR_X, step.page)
        renderer.nativeSimulateMouseDown(BAR_X, step.page)
        renderer.nativeSimulateMouseUp(BAR_X, step.page)
        check(`page at ${step.page}`)
      }
    }
    renderer.nativeSimulateMouseUp(BAR_X, 0)
    return reported
  } finally {
    app.unmount()
  }
}

describeNative("onVisibleRange of a scrollbar drag", () => {
  it("reports the rows at each position of the thumb, to the end and back, and nothing for a drag that moves nothing", () => {
    const reported = dragged(undefined, 5, 10, [
      { move: 30 },
      { move: 30 },
      { move: 60 },
      { move: 200 },
      { move: 400 },
      { move: 40 },
      { move: -80 },
      { move: -90 },
      { page: 95 },
      { page: 95 },
    ])
    expect(reported).toBeGreaterThanOrEqual(6)
  })

  it("reports the rows of a bottom-aligned list dragged to its end, where its anchor is no row, and back", () => {
    const reported = dragged("bottom", -5, 88, [
      { move: 60 },
      { move: 30 },
      { move: 400 },
      { move: 400 },
      { move: 60 },
      { move: 400 },
      { move: -80 },
      { move: 400 },
      { page: 5 },
    ])
    expect(reported).toBeGreaterThanOrEqual(6)
  })
})

describeNative("onVisibleRange of a write to the end of a bottom-aligned list", () => {
  it("reports the rows that show at the end, not the item count and the one after", () => {
    const app = createTestRoot()
    try {
      const renderer = app.renderer
      const ranges: Range[] = []
      app.render(sizedList(true, (event) => ranges.push([event.startIndex, event.endIndex]), "bottom"))
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      const list = renderer.findByTestId("list")!.id
      let last: Range = [undefined, undefined]
      for (const [offset, rows] of [[100, [2, 5]], [LAST_OFFSET, [ROWS - 3, ROWS]], [LAST_OFFSET - 1, [ROWS - 3, ROWS]], [0, [0, 3]], [LAST_OFFSET + 50, [ROWS - 3, ROWS]]] as const) {
        ranges.length = 0
        renderer.scrollTo(list, 0, offset)
        renderer.drawFrame()
        renderer.dispatchNativeEvents()
        expect(paintedRange(renderer), `at ${offset}, the rows painted`).toEqual(rows)
        expect(ranges, `at ${offset}`).toEqual(JSON.stringify(last) === JSON.stringify(rows) ? [] : [rows])
        last = [...rows]
      }
    } finally {
      app.unmount()
    }
  })
})

const COUNT = 200
const VIEW = 300
const WINDOW = 60
const WINDOW_STEP = 10
const WINDOW_LEAD = 15
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "visible-range-"))

const rowColor = (index: number) => `rgb(${(index * 37) % 256}, ${(index * 91) % 256}, ${(index * 53) % 256})`

function Row(props: { index: number }) {
  return (
    <div testId={`row-${props.index}`} style={{ width: 150, height: ROW, flexShrink: 0, backgroundColor: rowColor(props.index) }}>
      <div style={{ color: "#ffffff" }}>{`row-${props.index}`}</div>
    </div>
  )
}

/** The rows of a window the app moves from `onVisibleRange`, as ghia-bench's mailbox does. */
function windowed(onRange: (event: DomEvent) => void) {
  return () => {
    const [start, setStart] = createSignal(0)
    const indices = () => Array.from({ length: WINDOW }, (_, offset) => start() + offset).filter((index) => index < COUNT)
    return (
      <virtual-list
        testId="list"
        itemCount={COUNT}
        windowStart={start()}
        estimatedItemHeight={ROW}
        style={{ width: 200, height: VIEW, scrollbarWidth: "none" }}
        onVisibleRange={(event) => {
          onRange(event)
          setStart(Math.max(0, Math.floor(((event.startIndex ?? 0) - WINDOW_LEAD) / WINDOW_STEP) * WINDOW_STEP))
        }}
      >
        <For each={indices()}>{(index) => <Row index={index} />}</For>
      </virtual-list>
    )
  }
}

function whole() {
  return (
    <virtual-list testId="list" itemCount={COUNT} estimatedItemHeight={ROW} style={{ width: 200, height: VIEW, scrollbarWidth: "none" }}>
      <For each={Array.from({ length: COUNT }, (_, index) => index)}>{(index) => <Row index={index} />}</For>
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
const revealing = (index: number) => Math.max(0, (index + 1) * ROW - VIEW)

const KEYS = 120
const SHOWN = [10, 52, 70, 119]

describeNative("a list windowed from onVisibleRange under keyboard navigation", () => {
  it("moves its window with the rows, paints them, and reports each range once", () => {
    const ranges: Range[] = []
    const shown = new Map<number, string>()
    const app = createTestRoot({ width: 300, height: 400 })
    try {
      app.renderer.setA11yActive(false)
      app.render(windowed((event) => ranges.push([event.startIndex, event.endIndex])))
      app.renderer.drawFrame()
      app.renderer.dispatchNativeEvents()
      const id = app.renderer.findByTestId("list")!.id
      for (let key = 1; key <= KEYS; key++) {
        app.renderer.scrollTo(id, 0, revealing(key))
        app.renderer.drawFrame()
        app.renderer.dispatchNativeEvents()
        app.renderer.drawFrame()
        expect(app.renderer.findByTestId(`row-${key}`), `row ${key} is mounted at key ${key}`).not.toBeNull()
        if (SHOWN.includes(key)) shown.set(key, picture(app.renderer, `windowed-${key}`))
      }
    } finally {
      app.unmount()
    }

    const expected: Range[] = []
    let at = 0
    for (let key = 1; key <= KEYS; key++) {
      const offset = revealing(key)
      if (offset === at) continue
      at = offset
      const range: Range = [Math.floor(offset / ROW), Math.min(COUNT, Math.ceil((offset + VIEW) / ROW))]
      if (JSON.stringify(expected[expected.length - 1]) !== JSON.stringify(range)) expected.push(range)
    }
    expect(ranges).toEqual(expected)

    const reference = createTestRoot({ width: 300, height: 400 })
    try {
      reference.renderer.setA11yActive(false)
      reference.render(whole)
      reference.renderer.drawFrame()
      const id = reference.renderer.findByTestId("list")!.id
      const blank = picture(reference.renderer, "whole-0")
      for (const key of SHOWN) {
        reference.renderer.scrollTo(id, 0, revealing(key))
        reference.renderer.drawFrame()
        const picked = picture(reference.renderer, `whole-${key}`)
        expect(picked, `the frame at key ${key} shows rows`).not.toBe(blank)
        expect(shown.get(key), `the windowed list at key ${key} is the list with every row`).toBe(picked)
      }
    } finally {
      reference.unmount()
    }
  })
})
