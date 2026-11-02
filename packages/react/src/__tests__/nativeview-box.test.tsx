/// What the box of a `<nativeview>` paints: its shadow, background, border, outline and radius are
/// those of a `div` with the same style, and where they sit between the layers of the window.
/// The test renderer's screenshot is the Metal frame, every GPUI layer drawn and no native view,
/// so it shows what the box paints; `getCompositionLayers` shows which side of the native layer
/// each primitive is on.

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"
import { type Pixels, readPixels, SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const PAGE = "#e8e8e8"
const PAGE_CHANNEL = 0xe8
/** The box is 120 x 100 at (80, 80) of a 320 x 280 window. */
const BOX = { x: 80, y: 80, width: 120, height: 100 }

type Tag = "div" | "nativeview"
type Style = Record<string, unknown>

function pageOf(tag: Tag, style: Style) {
  const Box = tag
  return (
    <div style={{ padding: BOX.x, backgroundColor: PAGE }}>
      <Box style={{ width: BOX.width, height: BOX.height, ...style }} />
    </div>
  )
}

function shoot(root: TestRoot, name: string): Pixels {
  const file = `${SHOTS_DIR}/nativeview-box-${name}.png`
  fs.rmSync(file, { force: true })
  root.renderer.captureScreenshot(file)
  return readPixels(file)
}

function render(tag: Tag, style: Style, name: string) {
  const root = createTestRoot({ width: 320, height: 280 })
  try {
    root.render(pageOf(tag, style))
    return shoot(root, `${name}-${tag}`)
  } finally {
    root.unmount()
  }
}

function differing(a: Pixels, b: Pixels) {
  expect([b.width, b.height]).toEqual([a.width, a.height])
  let count = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (a.at(x, y).some((channel, index) => channel !== b.at(x, y)[index])) count++
    }
  }
  return count
}

function expectColor(actual: number[], expected: [number, number, number]) {
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(actual[channel]! - expected[channel]!), `channel ${channel} of ${actual}`).toBeLessThanOrEqual(4)
  }
}

/** The pixels of `<nativeview style>` against `<div style>`, which must be the same. */
function sameAsDiv(style: Style, name: string) {
  const div = render("div", style, name)
  const nativeview = render("nativeview", style, name)
  expect(differing(div, nativeview)).toBe(0)
  return nativeview
}

describeNative("nativeview box: what it paints is what a div paints", () => {
  describe("box-shadow", () => {
    it("paints a hard shadow with an offset, a spread and two layers", () => {
      const pixels = sameAsDiv(
        { backgroundColor: "#3366ff", boxShadow: "10px 12px 0 6px #ff0000, -8px -8px 0 2px #00aa00" },
        "shadow-hard",
      )
      // Right of the box, inside the red layer (x to 216) and outside the green one.
      expectColor(pixels.at(BOX.x + BOX.width + 10, BOX.y + 60), [255, 0, 0])
      // Left of the box, inside the green layer (x from 70) and outside the red one (from 84).
      expectColor(pixels.at(BOX.x - 5, BOX.y + 40), [0, 170, 0])
      // Past the spread of both.
      expectColor(pixels.at(BOX.x + BOX.width + 20, BOX.y + 60), [PAGE_CHANNEL, PAGE_CHANNEL, PAGE_CHANNEL])
    })

    it("paints a blurred shadow with a radius, falling off below the box", () => {
      const pixels = sameAsDiv(
        { backgroundColor: "#ffffff", borderRadius: 16, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" },
        "shadow-blur",
      )
      expect(pixels.at(BOX.x + BOX.width / 2, BOX.y + BOX.height + 4)[0]).toBeLessThan(180)
      expect(pixels.at(BOX.x + BOX.width / 2, BOX.y + BOX.height + 50)[0]).toBeGreaterThan(PAGE_CHANNEL - 4)
    })

    it("paints a shadow on a box with no background, and none inside the box", () => {
      const pixels = sameAsDiv({ boxShadow: "0 6px 20px 4px rgba(0,0,0,0.7)" }, "shadow-bare")
      expect(pixels.at(BOX.x + BOX.width / 2, BOX.y + BOX.height + 4)[0]).toBeLessThan(160)
      // As in CSS, an outer shadow is cut away under its own box.
      expectColor(pixels.at(BOX.x + BOX.width / 2, BOX.y + BOX.height / 2), [PAGE_CHANNEL, PAGE_CHANNEL, PAGE_CHANNEL])
    })

    it("is not cut by the element's own overflow: hidden and radius", () => {
      const pixels = sameAsDiv(
        {
          backgroundColor: "#ffffff",
          overflow: "hidden",
          borderRadius: 20,
          boxShadow: "0 0 0 8px #ff0000, 0 10px 30px #000000",
        },
        "shadow-overflow-hidden",
      )
      expectColor(pixels.at(BOX.x - 4, BOX.y + 50), [255, 0, 0])
    })

    it("follows a style change made after the box was painted and attached", () => {
      const shadow = { boxShadow: "0 0 0 10px #ff0000" }
      const div = render("div", { backgroundColor: "#ffffff", ...shadow }, "shadow-change")
      const root = createTestRoot({ width: 320, height: 280 })
      try {
        root.render(pageOf("nativeview", { backgroundColor: "#ffffff" }))
        root.renderer.dispatchNativeEvents()
        const before = shoot(root, "shadow-change-before")
        expectColor(before.at(BOX.x - 5, BOX.y + 50), [PAGE_CHANNEL, PAGE_CHANNEL, PAGE_CHANNEL])

        root.render(pageOf("nativeview", { backgroundColor: "#ffffff", ...shadow }))
        const added = shoot(root, "shadow-change-added")
        expectColor(added.at(BOX.x - 5, BOX.y + 50), [255, 0, 0])
        expect(differing(added, div)).toBe(0)

        root.render(pageOf("nativeview", { backgroundColor: "#ffffff" }))
        expect(differing(shoot(root, "shadow-change-removed"), before)).toBe(0)
      } finally {
        root.unmount()
      }
    })
  })

  it("paints its background, and not past a border radius", () => {
    const pixels = sameAsDiv({ backgroundColor: "#ffcc00", borderRadius: 24 }, "background")
    expectColor(pixels.at(BOX.x + 60, BOX.y + 50), [255, 204, 0])
    expectColor(pixels.at(BOX.x + 1, BOX.y + 1), [PAGE_CHANNEL, PAGE_CHANNEL, PAGE_CHANNEL])
  })

  it("paints its border", () => {
    const pixels = sameAsDiv(
      { backgroundColor: "#ffcc00", borderRadius: 24, borderWidth: 6, borderStyle: "solid", borderColor: "#aa0000" },
      "border",
    )
    expectColor(pixels.at(BOX.x + 2, BOX.y + 50), [170, 0, 0])
    expectColor(pixels.at(BOX.x + 60, BOX.y + 50), [255, 204, 0])
  })

  it("paints its outline, outside the box and clear of it by the offset", () => {
    const pixels = sameAsDiv(
      { backgroundColor: "#cccccc", borderRadius: 12, outline: "6px solid #00aa00", outlineOffset: 4 },
      "outline",
    )
    expectColor(pixels.at(BOX.x - 7, BOX.y + 50), [0, 170, 0])
    expectColor(pixels.at(BOX.x - 2, BOX.y + 50), [PAGE_CHANNEL, PAGE_CHANNEL, PAGE_CHANNEL])
  })

  describe("layers", () => {
    function layersOf(style: Style, child?: React.ReactNode) {
      const root = createTestRoot({ width: 320, height: 280 })
      try {
        root.render(
          <div style={{ padding: BOX.x, backgroundColor: PAGE }}>
            <nativeview style={{ width: BOX.width, height: BOX.height, ...style }}>{child}</nativeview>
          </div>,
        )
        return root.renderer
          .getCompositionLayers()
          .map((layer) => (layer.kind === "native" ? "native" : `gpui ${layer.primitives}`))
      } finally {
        root.unmount()
      }
    }

    it("puts the box's own paint, outer shadow included, under the native view", () => {
      expect(layersOf({ backgroundColor: "#ffffff" })).toEqual(["gpui 2", "native", "gpui 0"])
      expect(layersOf({ backgroundColor: "#ffffff", boxShadow: "0 8px 24px rgba(0,0,0,0.6)" })).toEqual([
        "gpui 3",
        "native",
        "gpui 0",
      ])
    })

    // The native view fills the padding box and what is under it is behind it, as the content of a
    // replaced element is above the element's inset shadow in no browser. See deviations.md.
    it("puts an inset shadow under the native view too, not above it", () => {
      expect(layersOf({ backgroundColor: "#ffffff", boxShadow: "inset 0 0 20px 10px #ff0000" })).toEqual([
        "gpui 3",
        "native",
        "gpui 0",
      ])
    })

    it("puts a child above the native view", () => {
      expect(
        layersOf({ boxShadow: "inset 0 0 20px 10px #ff0000" }, <div style={{ width: 20, height: 20, backgroundColor: "#00ff00" }} />),
      ).toEqual(["gpui 2", "native", "gpui 1"])
    })
  })
})
