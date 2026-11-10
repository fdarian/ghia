// @ts-nocheck
/**
 * A virtual list tells the list the size of a row whose root style fixes it (`list_sizes.rs`, zed `ListState::set_exact_item_size`), so a
 * row that does not show is not built and laid out to be measured, and the row that shows is checked against it. What the list lays out
 * is what the style declared (`getPatchCounters().scrollPatch.declarationMismatches` stays 0, for every style below), a style that leaves
 * the box to layout declares nothing, and a list that declares is the same list as one that does not: the boxes, the scroll extent and the
 * thumb, the picture, after a wheel and after `scrollTo`.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const TIMEOUT = 120_000
const VIEW = 300
const WIDTH = 240

type Row = (index: number) => Record<string, unknown>

const tall = (index: number) => 24 + ((index * 7) % 5) * 6

/** Each is a style of the root of a row; `declares` is whether the list is told its size. */
const STYLES: Array<[string, Row, boolean]> = [
  ["a height in px", (i) => ({ height: tall(i) }), true],
  ["a height in px and a position", (i) => ({ height: tall(i), position: "relative", userSelect: "none" }), true],
  ["a width and a height", (i) => ({ width: 180, height: tall(i) }), true],
  ["padding inside the height", (i) => ({ height: tall(i), padding: 6 }), true],
  ["padding and a border below", (i) => ({ height: tall(i), padding: "4px 9px", borderBottom: "1px solid #dddddd" }), true],
  ["a border all around", (i) => ({ height: tall(i), border: "3px solid #888888" }), true],
  ["a border finer than a pixel", (i) => ({ height: tall(i), border: "0.4px solid #888888" }), true],
  ["a border of a pixel and a half", (i) => ({ height: tall(i), borderTop: "1.5px solid #888888", borderBottom: "2.5px solid #888888" }), true],
  ["a border with no style", (i) => ({ height: tall(i), border: "4px none #888888" }), true],
  ["a height below its padding", (i) => ({ height: 4 + (i % 3), paddingTop: 7, paddingBottom: 9 }), true],
  ["a height below its border", (i) => ({ height: 2, borderTop: "5px solid red", borderBottom: "3px solid red" }), true],
  ["a width below its padding", (i) => ({ width: 8, height: tall(i), paddingLeft: 9, paddingRight: 9 }), true],
  ["margins on every side", (i) => ({ height: tall(i), margin: "7px 5px 9px 3px" }), true],
  ["vertical margins", (i) => ({ height: tall(i), marginTop: 10, marginBottom: 14 }), true],
  ["horizontal margins", (i) => ({ height: tall(i), marginLeft: 12, marginRight: 20 }), true],
  ["a flex container with a width", (i) => ({ width: 200, height: tall(i), display: "flex", alignItems: "center", padding: 4 }), true],
  ["a grid container with a width", (i) => ({ width: 200, height: tall(i), display: "grid", gridTemplateColumns: "1fr 2fr", gap: 4 }), true],
  ["a flex container with no width", (i) => ({ height: tall(i), display: "flex", alignItems: "center", padding: 4 }), false],
  ["a grid container with no width", (i) => ({ height: tall(i), display: "grid", gridTemplateColumns: "1fr 2fr", gap: 4 }), false],
  ["a fractional height", (i) => ({ height: 20.37 + i * 0.11 }), true],
  ["a hover that paints", (i) => ({ height: tall(i), backgroundColor: "#ffffff", hover: { backgroundColor: "#dbeafe", boxShadow: "0 0 2px #888888" } }), true],
  ["a transition that paints", (i) => ({ height: tall(i), transition: "background-color 0.2s, opacity 0.1s", hover: { backgroundColor: "#dbeafe" } }), true],
  ["no height", () => ({}), false],
  ["a percent height", () => ({ height: "30%" }), false],
  ["an em height", () => ({ height: "2em" }), false],
  ["a calc height", () => ({ height: "calc(100% - 20px)" }), false],
  ["a min height", (i) => ({ height: tall(i), minHeight: 30 }), false],
  ["a max height", (i) => ({ height: tall(i) + 20, maxHeight: 30 }), false],
  ["a min width", (i) => ({ height: tall(i), minWidth: 10 }), false],
  ["a percent width", (i) => ({ height: tall(i), width: "50%" }), false],
  ["an aspect ratio", (i) => ({ width: 120, aspectRatio: "3 / 1" }), false],
  ["an absolute position", (i) => ({ height: tall(i), position: "absolute" }), false],
  ["a hover that pads", (i) => ({ height: tall(i), hover: { paddingTop: 10 } }), false],
  ["a transition of the height", (i) => ({ height: tall(i), transition: "height 0.2s" }), false],
  ["a min height from a var", (i) => ({ "--m": "40px", height: tall(i), minHeight: "var(--m)" }), false],
  ["a padding from a var", (i) => ({ "--p": "9px", height: tall(i), padding: "var(--p)" }), false],
  ["a border from a var", (i) => ({ "--b": "4px solid red", height: tall(i), borderBottom: "var(--b)" }), false],
  ["a position from a var", (i) => ({ "--o": "absolute", height: tall(i), position: "var(--o)" }), false],
  ["a display from a var", (i) => ({ "--d": "inline-block", height: tall(i), display: "var(--d)" }), false],
  ["a hover that pads by a var", (i) => ({ "--p": "10px", height: tall(i), hover: { paddingTop: "var(--p)" } }), false],
]

function Rows({ row, count = 30, estimated = false, extra = {} }: { row: Row; count?: number; estimated?: boolean; extra?: object }) {
  return (
    <div style={{ width: WIDTH + 40, height: VIEW + 40, backgroundColor: "#ffffff" }}>
      <virtual-list
        testId="list"
        estimatedItemHeight={estimated ? 40 : undefined}
        overdraw={64}
        style={{ width: WIDTH, height: VIEW }}
        {...extra}
      >
        {Array.from({ length: count }, (_, index) => (
          <div key={index} testId={`row-${index}`} style={{ backgroundColor: index % 2 ? "#eeeeee" : "#ffffff", ...row(index) }}>
            <div style={{ color: "#222222" }}>{`row ${index}`}</div>
          </div>
        ))}
      </virtual-list>
    </div>
  )
}

function picture(renderer, name: string): string {
  const file = `${SHOTS_DIR}/list-exact-sizes-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const element of renderer.findByType("div")) {
    const box = renderer.getElementBounds(element.id)
    if (box) out[String(element.testId ?? element.id)] = box
  }
  return out
}

function measures(renderer) {
  const scroll = renderer.getPatchCounters().scrollPatch
  return {
    byLayout: scroll.rowsMeasuredByLayout,
    byDeclaration: scroll.rowsMeasuredByDeclaration,
    mismatches: scroll.declarationMismatches,
  }
}

const WHEEL_AT = [WIDTH / 2, VIEW / 2]

/** Wheels and `scrollTo`s down the list and back, every step seen. */
function run(row: Row, declared: boolean, options: { count?: number; estimated?: boolean; extra?: object; name: string; warm?: boolean }) {
  const root = createTestRoot({ width: WIDTH + 40, height: VIEW + 40 })
  const renderer = root.renderer
  renderer.setListSizesEnabled(declared)
  renderer.setA11yActive(false)
  // A hover that starts a transition is painted at the time it has run since, and the two lists are not drawn in the same
  // milliseconds: a clock that runs makes the pictures differ with the load of the machine.
  renderer.clockPause()
  try {
    root.render(<Rows row={row} count={options.count} estimated={options.estimated} extra={options.extra} />)
    renderer.dispatchNativeEvents()
    renderer.flush()
    const list = renderer.findByTestId("list")!.id
    if (options.warm) {
      // Every row shows once, so every row is measured whichever way the list measures.
      for (let to = 0; to < 5000; to += 100) renderer.scrollTo(list, 0, to)
      for (let to = 5000; to >= 0; to -= 100) renderer.scrollTo(list, 0, to)
    }
    const seen = []
    const look = (label: string) =>
      seen.push({
        label,
        boxes: boxes(renderer),
        metrics: renderer.getScrollMetrics(list),
        picture: picture(renderer, `${options.name}-${declared}-${seen.length}`),
      })
    look("first")
    for (const dy of [37, 120, 260, 41, -90]) {
      renderer.nativeSimulateMouseMove(WHEEL_AT[0], WHEEL_AT[1])
      renderer.nativeSimulateScrollWheel(WHEEL_AT[0], WHEEL_AT[1], 0, dy)
      renderer.dispatchNativeEvents()
      look(`wheel ${dy}`)
    }
    for (const to of [900, 310, 1500, 0, 55]) {
      renderer.scrollTo(list, 0, to)
      look(`scrollTo ${to}`)
    }
    return { seen, measures: measures(renderer), built: renderer.getBuildCounters().elementsBuilt }
  } finally {
    renderer.setListSizesEnabled(true)
    root.unmount()
  }
}

describeNative("a list that is told the size of its rows", { timeout: TIMEOUT }, () => {
  describe.each(STYLES)("rows with %s", (name, row, declares) => {
    it(declares ? "lays out at the size it declared, and is the list that is not told" : "is told nothing, and is measured by layout", () => {
      const slug = name.replace(/\W+/g, "-")
      const on = run(row, true, { name: slug })
      const off = run(row, false, { name: slug })
      expect(on.measures.mismatches, JSON.stringify(on.measures)).toBe(0)
      expect(off.measures.byDeclaration).toBe(0)
      if (declares) {
        expect(on.measures.byDeclaration, JSON.stringify(on.measures)).toBeGreaterThan(0)
        expect(on.measures.byLayout, "every row was told").toBe(0)
      } else {
        expect(on.measures.byDeclaration, JSON.stringify(on.measures)).toBe(0)
        expect(on.measures.byLayout).toBe(off.measures.byLayout)
      }
      expect(on.seen).toEqual(off.seen)
    })
  })

  it("measures by layout only the rows that are not told, in a list of both", () => {
    const row = (index: number) => (index % 3 === 0 ? { minHeight: 20 + index } : { height: tall(index) })
    const on = run(row, true, { name: "mixed" })
    const off = run(row, false, { name: "mixed" })
    expect(on.measures.mismatches).toBe(0)
    expect(on.measures.byDeclaration).toBeGreaterThan(0)
    expect(on.measures.byLayout).toBeGreaterThan(0)
    expect(on.measures.byLayout).toBeLessThan(off.measures.byLayout)
    expect(on.measures.byLayout + on.measures.byDeclaration).toBe(off.measures.byLayout)
    expect(on.seen).toEqual(off.seen)
  })

  it("does not build the rows it measures but does not show, and shows the same list", () => {
    const row = (index: number) => ({ height: tall(index), padding: 4, borderBottom: "1px solid #dddddd" })
    const on = run(row, true, { name: "scratch", count: 120 })
    const off = run(row, false, { name: "scratch", count: 120 })
    expect(on.measures.byLayout).toBe(0)
    expect(on.measures.mismatches).toBe(0)
    expect(on.built, "a row that does not show is not built to be measured").toBeLessThan(off.built)
    expect(on.seen).toEqual(off.seen)
  })

  it("declares the rows of a windowed list for its window only", () => {
    const window = (declared: boolean) => {
      const root = createTestRoot({ width: WIDTH + 40, height: VIEW + 40 })
      const renderer = root.renderer
      renderer.setListSizesEnabled(declared)
      renderer.setA11yActive(false)
      try {
        root.render(
          <Rows
            row={(index) => ({ height: tall(index) })}
            count={20}
            extra={{ itemCount: 200, windowStart: 40 }}
          />
        )
        renderer.dispatchNativeEvents()
        renderer.flush()
        const list = renderer.findByTestId("list")!.id
        const seen = []
        for (const to of [0, 2500, 9000, 100, 12000]) {
          renderer.scrollTo(list, 0, to)
          seen.push({ metrics: renderer.getScrollMetrics(list), picture: picture(renderer, `window-${declared}-${seen.length}`) })
        }
        return { seen, measures: measures(renderer) }
      } finally {
        renderer.setListSizesEnabled(true)
        root.unmount()
      }
    }
    const on = window(true)
    const off = window(false)
    expect(on.measures.mismatches).toBe(0)
    expect(on.seen).toEqual(off.seen)
  })

  it("is the list that is not told, with rows the list estimates, once every row is measured", () => {
    const row = (index: number) => ({ height: tall(index), padding: 4, borderBottom: "1px solid #dddddd" })
    const on = run(row, true, { name: "estimated", count: 120, estimated: true, warm: true })
    const off = run(row, false, { name: "estimated", count: 120, estimated: true, warm: true })
    expect(on.measures.mismatches).toBe(0)
    expect(on.seen).toEqual(off.seen)
  })

  it("follows a row whose height changes", () => {
    const root = createTestRoot({ width: WIDTH + 40, height: VIEW + 40 })
    const renderer = root.renderer
    renderer.setA11yActive(false)
    try {
      const page = (taller: number) => <Rows row={(index) => ({ height: index === 3 ? 30 + taller : 30 })} count={40} />
      root.render(page(0))
      renderer.dispatchNativeEvents()
      renderer.flush()
      const list = renderer.findByTestId("list")!.id
      renderer.scrollTo(list, 0, 600)
      renderer.scrollTo(list, 0, 0)
      const before = renderer.getScrollMetrics(list)
      root.render(page(50))
      renderer.dispatchNativeEvents()
      renderer.flush()
      const row = renderer.getElementBounds(renderer.findByTestId("row-3")!.id)
      expect(row.height).toBe(80)
      const after = renderer.getScrollMetrics(list)
      expect(after[3]).toBe(before[3] + 50)
      expect(measures(renderer).mismatches).toBe(0)
    } finally {
      root.unmount()
    }
  })
})
