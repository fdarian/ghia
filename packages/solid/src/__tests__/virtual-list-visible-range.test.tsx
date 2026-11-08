/**
 * `onVisibleRange` of a list fires for a write to its scroll position as it does for a wheel (scroll.md, "onVisibleRange fires when the
 * visible range changes"): the range is the one a wheel to the same offset reports, a range is reported once, and an app that moves a
 * window of rows from it follows a run of keys that scroll the list with `scrollTo`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, createSignal } from "solid-js"
import { describe, expect, it } from "bun:test"
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
            <text>{`row-${index}`}</text>
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
      expect(ranges).toEqual([[5, 8]])
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
      <text style={{ color: "#ffffff" }}>{`row-${props.index}`}</text>
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
