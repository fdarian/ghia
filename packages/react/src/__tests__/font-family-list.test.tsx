/// CSS `font-family` is a list: each glyph is drawn in the first family of it that is installed and has the glyph. A web
/// stack names fonts that a Mac does not have ("Segoe UI", Roboto) before the ones it has, and a system UI keyword stands
/// for the font the OS draws its UI in. Ghia hands GPUI the first installed family and the installed ones after it as
/// its fallbacks, so each stack is measured against the family it has to resolve to. A family GPUI cannot load is drawn
/// in its own fallback stack (Helvetica on a stock Mac), which counts as installed when the list names it.

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const TEXT = "The quick brown fox jumps over the lazy dog, 0123456789 ilWm"

// "A" is one em wide and "B" two, drawn as squares, so "AB" at 20px is 60 wide in this font; it has no other glyph.
const SQUARE_FONT = fs.readFileSync(new URL("./fixtures/gpuix-test-square.ttf", import.meta.url))

type Root = ReturnType<typeof createTestRoot>

function measure(root: Root, fontFamily: string, text: string): number {
  root.render(
    <div style={{ display: "flex" }}>
      <span testId="text" style={{ fontFamily, fontSize: 20 }}>
        {text}
      </span>
    </div>
  )
  const element = root.renderer.findByTestId("text")
  expect(element, "the text is mounted").toBeDefined()
  const bounds = root.renderer.getElementBounds(element!.id)
  expect(bounds, "the text has a box").not.toBeNull()
  return bounds!.width
}

function withRoot<T>(body: (root: Root) => T): T {
  const root = createTestRoot()
  try {
    return body(root)
  } finally {
    root.unmount()
  }
}

function widthOf(fontFamily: string, text = TEXT): number {
  return withRoot((root) => measure(root, fontFamily, text))
}

describeNative("font-family lists", () => {
  const helvetica = widthOf("Helvetica Neue")
  const missing = widthOf("No Such Family")

  it("a family that is not installed draws in GPUI's fallback face", () => {
    expect(missing).not.toBeCloseTo(helvetica, 1)
  })

  it("skips families that are not installed", () => {
    expect(widthOf("'Segoe UI', Roboto, 'Helvetica Neue', sans-serif")).toBeCloseTo(helvetica, 3)
    expect(widthOf('"No Such Family", "Helvetica Neue"')).toBeCloseTo(helvetica, 3)
  })

  it("takes a quoted single family", () => {
    expect(widthOf("'Helvetica Neue'")).toBeCloseTo(helvetica, 3)
  })

  it("matches family names without regard to case", () => {
    expect(widthOf("NO SUCH FAMILY, hElVeTiCa NeUe")).toBeCloseTo(helvetica, 3)
  })

  it("counts the face GPUI falls back to as installed when the list names it", () => {
    // Helvetica is the face a family that does not load resolves to on a stock Mac, so a list
    // that is tested against "differs from the fallback" would skip it for Menlo.
    expect(widthOf("Helvetica, Menlo")).toBeCloseTo(widthOf("Helvetica"), 3)
    expect(widthOf("Helvetica, Menlo")).not.toBeCloseTo(widthOf("Menlo"), 1)
  })

  it("maps the generic families to what Chrome uses on macOS", () => {
    expect(widthOf("monospace")).toBeCloseTo(widthOf("Menlo"), 3)
    expect(widthOf("sans-serif")).toBeCloseTo(widthOf("Helvetica"), 3)
    expect(widthOf("serif")).toBeCloseTo(widthOf("Times"), 3)
    expect(widthOf("cursive")).toBeCloseTo(widthOf("Apple Chancery"), 3)
    expect(widthOf("SERIF")).toBeCloseTo(widthOf("Times"), 3)
  })

  it("reads a quoted generic as a family name", () => {
    expect(widthOf("'monospace', Helvetica")).toBeCloseTo(widthOf("Helvetica"), 3)
    expect(widthOf("'monospace', Helvetica")).not.toBeCloseTo(widthOf("Menlo"), 1)
  })

  it("reads backslash escapes and collapses whitespace runs in unquoted names", () => {
    expect(widthOf("Helvetica\\ Neue")).toBeCloseTo(helvetica, 3)
    expect(widthOf("Helvetica   Neue")).toBeCloseTo(helvetica, 3)
    expect(widthOf('"Helvetica\\20 Neue"')).toBeCloseTo(helvetica, 3)
  })

  it("draws a system UI stack in the system font", () => {
    const system = widthOf("system-ui")
    expect(widthOf("-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif")).toBeCloseTo(system, 3)
    expect(system).not.toBeCloseTo(missing, 1)
  })

  it("leaves a list that nothing in is installed as GPUI resolves it", () => {
    expect(widthOf("'Segoe UI', Roboto")).toBeCloseTo(missing, 3)
  })

  it("falls back glyph by glyph through the rest of the list", () => {
    withRoot((root) => {
      root.renderer.registerFont(SQUARE_FONT)
      const menloZ = measure(root, "Menlo", "Z")
      expect(measure(root, "GpuixTestSquare", "AB")).toBeCloseTo(60, 0)
      // "Z" is not in the square font: it comes from the next family of the list, not from GPUI's fallback face.
      expect(measure(root, "GpuixTestSquare, Menlo", "ABZ")).toBeCloseTo(60 + menloZ, 0)
      expect(measure(root, "GpuixTestSquare, 'Segoe UI', Menlo", "ABZ")).toBeCloseTo(60 + menloZ, 0)
      expect(measure(root, "GpuixTestSquare, Helvetica", "ABZ")).not.toBeCloseTo(60 + menloZ, 1)
    })
  })

  it("resolves a list against the fonts of its own App, not the first one made", () => {
    // The test renderer makes an App per root and drops the one before it.
    withRoot((first) => {
      expect(measure(first, "GpuixTestSquare, Menlo", "AB")).not.toBeCloseTo(60, 0)
    })
    withRoot((second) => {
      second.renderer.registerFont(SQUARE_FONT)
      expect(measure(second, "GpuixTestSquare, Menlo", "AB")).toBeCloseTo(60, 0)
    })
    withRoot((third) => {
      expect(measure(third, "GpuixTestSquare, Menlo", "AB")).not.toBeCloseTo(60, 0)
    })
  })

  it("picks up a font registered after the list was first resolved", () => {
    withRoot((root) => {
      expect(measure(root, "GpuixTestSquare, Menlo", "AB")).not.toBeCloseTo(60, 0)
      root.renderer.registerFont(SQUARE_FONT)
      expect(measure(root, "GpuixTestSquare, Menlo", "AB")).toBeCloseTo(60, 0)
    })
  })

  it("resolves the list of a <code> element as it does for text", () => {
    const codeWidth = (root: Root, fontFamily: string): number => {
      root.render(
        <div style={{ display: "flex" }}>
          <code testId="code" code="ABAB" language="ts" style={{ fontFamily, fontSize: 20 }} />
        </div>
      )
      const element = root.renderer.findByTestId("code")
      expect(element, "the code is mounted").toBeDefined()
      return root.renderer.getElementBounds(element!.id)!.width
    }
    withRoot((root) => {
      root.renderer.registerFont(SQUARE_FONT)
      const square = codeWidth(root, "GpuixTestSquare")
      expect(square, "the registered font draws the code").toBeCloseTo(120, 0)
      expect(codeWidth(root, "'Segoe UI', GpuixTestSquare, Menlo")).toBeCloseTo(square, 3)
    })
  })
})
