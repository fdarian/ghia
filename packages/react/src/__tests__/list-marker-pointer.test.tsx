/// The marker of a list item is part of the item for the pointer, and its style is the item's state style: in Chrome
/// `elementFromPoint` over a bullet returns the `li`, the click lands on it, `li:hover` applies there, and
/// `li:hover { list-style-type }` changes the bullet.

import React from "react"
import { describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { expectScreenshotsEqual, readLogicalPixels, SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type TestRoot = ReturnType<typeof createTestRoot>

const PAGE = { width: 300, height: 120, backgroundColor: "#ffffff", color: "#000000", fontSize: 16, lineHeight: "24px", fontFamily: "Helvetica" }

/** Where headless Chrome hits an `li` of a `ul` with the item at x = 40: the bullet's box, 17 to 10 px before it. */
const BULLET = { x: 26, y: 12 }

function shot(root: TestRoot, name: string): string {
  root.renderer.dispatchNativeEvents()
  const file = `${SHOTS_DIR}/list-marker-pointer-${name}.png`
  root.renderer.captureScreenshot(file)
  return file
}

function withRoot(render: (root: TestRoot) => void, run: (root: TestRoot) => void) {
  const root = createTestRoot({ width: 300, height: 120 })
  try {
    render(root)
    run(root)
  } finally {
    root.unmount()
  }
}

describeNative("the pointer over an outside marker", () => {
  it("elementFromPoint returns the item over the box of its bullet and of its number", () => {
    let item: unknown
    const hits = (x: number, y: number) => document.elementFromPoint(x, y) === item
    withRoot(
      (root) =>
        root.render(
          <div style={PAGE}>
            <ul style={{ margin: 0, paddingLeft: 40 }}>
              <li ref={(instance) => void (item = instance)}>text</li>
            </ul>
          </div>
        ),
      () => {
        expect(hits(BULLET.x, BULLET.y), "on the bullet").toBe(true)
        expect(hits(BULLET.x, 30), "under the first line").toBe(false)
        expect(hits(12, BULLET.y), "left of the marker").toBe(false)
      }
    )
    withRoot(
      (root) =>
        root.render(
          <div style={PAGE}>
            <ol style={{ margin: 0, paddingLeft: 40 }}>
              <li ref={(instance) => void (item = instance)}>text</li>
            </ol>
          </div>
        ),
      () => {
        expect(hits(30, 12), "on the number").toBe(true)
        expect(hits(8, 12), "left of the number").toBe(false)
      }
    )
  })

  it("a click on the bullet is the item's", () => {
    const log: string[] = []
    withRoot(
      (root) =>
        root.render(
          <div style={PAGE}>
            <ul style={{ margin: 0, paddingLeft: 40 }} onClick={() => log.push("ul")}>
              <li onClick={(event) => log.push(`li:${event.target === event.currentTarget}`)}>text</li>
            </ul>
          </div>
        ),
      (root) => {
        root.renderer.nativeSimulateClick(BULLET.x, BULLET.y)
        expect(log).toEqual(["li:true", "ul"])
      }
    )
  })

  it("the item's hover style applies over the bullet", () => {
    withRoot(
      (root) =>
        root.render(
          <div style={PAGE}>
            <ul style={{ margin: 0, paddingLeft: 40 }}>
              <li style={{ backgroundColor: "#ff0000", hover: { backgroundColor: "#0000ff" } }}>text</li>
            </ul>
          </div>
        ),
      (root) => {
        root.renderer.nativeSimulateMouseMove(250, 100)
        expect(readLogicalPixels(shot(root, "hover-off"), root.renderer).at(150, 12)).toEqual([255, 0, 0, 255])
        root.renderer.nativeSimulateMouseMove(BULLET.x, BULLET.y)
        expect(readLogicalPixels(shot(root, "hover-on"), root.renderer).at(150, 12)).toEqual([0, 0, 255, 255])
      }
    )
  })

  it("a marker that no pointer event reaches is none of the item's: pointer-events none", () => {
    let item: unknown
    withRoot(
      (root) =>
        root.render(
          <div style={PAGE}>
            <ul style={{ margin: 0, paddingLeft: 40 }}>
              <li ref={(instance) => void (item = instance)} style={{ pointerEvents: "none" }}>
                text
              </li>
            </ul>
          </div>
        ),
      () => expect(document.elementFromPoint(BULLET.x, BULLET.y) === item).toBe(false)
    )
  })
})

describeNative("list-style in a state style", () => {
  function list(props: { ul?: Record<string, unknown>; li?: Record<string, unknown>; sheet?: string }) {
    return (
      <div style={{ ...PAGE, width: 300 }}>
        {props.sheet ? <style>{props.sheet}</style> : null}
        <ul style={{ margin: 0, paddingLeft: 40, color: "#ff0000", ...props.ul }}>
          <li style={props.li}>
            <span style={{ color: "#000000" }}>text</span>
          </li>
        </ul>
      </div>
    )
  }

  /** The list with its state style applied by the pointer is drawn as a list that has the style outright is, and as before when the pointer leaves. */
  function equalsFresh(state: Parameters<typeof list>[0], after: Parameters<typeof list>[0], name: string) {
    let expected = ""
    withRoot(
      (root) => root.render(list(after)),
      (root) => {
        root.renderer.nativeSimulateMouseMove(250, 100)
        expected = shot(root, `${name}-fresh`)
      }
    )
    withRoot(
      (root) => root.render(list(state)),
      (root) => {
        root.renderer.nativeSimulateMouseMove(250, 100)
        const before = shot(root, `${name}-before`)
        expect(() => expectScreenshotsEqual(before, expected), "the hover state differs from the plain one").toThrow()
        root.renderer.nativeSimulateMouseMove(150, 12)
        expectScreenshotsEqual(shot(root, `${name}-hovered`), expected)
        root.renderer.nativeSimulateMouseMove(250, 100)
        expectScreenshotsEqual(shot(root, `${name}-left`), before)
      }
    )
  }

  it("`hover: { listStyleType }` on the item changes its marker", () => {
    equalsFresh({ li: { hover: { listStyleType: "square" } } }, { li: { listStyleType: "square" } }, "inline-li")
  })

  it("`hover: { listStyleType }` on the list reaches the items that inherit it", () => {
    equalsFresh({ ul: { hover: { listStyleType: "decimal" } } }, { ul: { listStyleType: "decimal" } }, "inline-ul")
  })

  it("`hover: { listStylePosition }` moves the marker inside", () => {
    equalsFresh({ li: { hover: { listStylePosition: "inside" } } }, { li: { listStylePosition: "inside" } }, "position")
  })

  it("`li:hover { list-style-type }` of a sheet changes the marker", () => {
    equalsFresh({ sheet: "li:hover{list-style-type:square}" }, { sheet: "li{list-style-type:square}" }, "sheet")
  })
})
