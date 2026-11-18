/// CSS `font-family` is a list and the first installed family draws. A web stack names fonts that a Mac does not have
/// ("Segoe UI", Roboto) before the ones it has, and a system UI keyword stands for the font the OS draws its UI in; GPUI
/// takes one family and falls back to its bundled sans when it is not installed, so each stack is measured against the
/// single family it has to resolve to.

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const TEXT = "The quick brown fox jumps over the lazy dog, 0123456789 ilWm"

function widthOf(fontFamily: string): number {
  const { render, renderer, unmount } = createTestRoot()
  try {
    render(
      <div style={{ display: "flex" }}>
        <span testId="text" style={{ fontFamily, fontSize: 20 }}>
          {TEXT}
        </span>
      </div>
    )
    const element = renderer.findByTestId("text")
    expect(element, "the text is mounted").toBeDefined()
    const bounds = renderer.getElementBounds(element!.id)
    expect(bounds, "the text has a box").not.toBeNull()
    return bounds!.width
  } finally {
    unmount()
  }
}

describeNative("font-family lists", () => {
  const helvetica = widthOf("Helvetica Neue")
  const missing = widthOf("No Such Family")

  it("a family that is not installed draws in the bundled fallback", () => {
    expect(missing).not.toBeCloseTo(helvetica, 1)
  })

  it("skips families that are not installed", () => {
    expect(widthOf("'Segoe UI', Roboto, 'Helvetica Neue', sans-serif")).toBeCloseTo(helvetica, 3)
    expect(widthOf('"No Such Family", "Helvetica Neue"')).toBeCloseTo(helvetica, 3)
  })

  it("takes a quoted single family", () => {
    expect(widthOf("'Helvetica Neue'")).toBeCloseTo(helvetica, 3)
  })

  it("maps the generic families to what Chrome uses on macOS", () => {
    expect(widthOf("monospace")).toBeCloseTo(widthOf("Menlo"), 3)
    expect(widthOf("sans-serif")).toBeCloseTo(widthOf("Helvetica"), 3)
    expect(widthOf("serif")).toBeCloseTo(widthOf("Times"), 3)
  })

  it("draws a system UI stack in the system font", () => {
    const system = widthOf("system-ui")
    expect(widthOf("-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif")).toBeCloseTo(system, 3)
    expect(system).not.toBeCloseTo(missing, 1)
  })

  it("leaves a list that nothing in is installed as GPUI resolves it", () => {
    expect(widthOf("'Segoe UI', Roboto")).toBeCloseTo(missing, 3)
  })
})
