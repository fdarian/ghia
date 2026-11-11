/** `document.elementFromPoint` and `elementsFromPoint` against the real test renderer. */
import React from "react"
import { describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("document.elementFromPoint", () => {
  it("finds an element mounted in the same turn, and lists body then html after it", () => {
    let outer: unknown
    let inner: unknown
    const { render } = createTestRoot()
    render(
      <div ref={(element) => (outer = element)} style={{ width: 200, height: 200 }}>
        <div ref={(element) => (inner = element)} style={{ width: 50, height: 50 }} />
      </div>
    )
    expect(document.elementFromPoint(10, 10)).toBe(inner)
    expect(document.elementsFromPoint(10, 10)).toEqual([inner, outer, document.body, document.documentElement])
    expect(document.elementFromPoint(100, 100)).toBe(outer)
    expect(document.elementFromPoint(300, 300)).toBe(document.body)
  })

  it("is null and empty outside the window", () => {
    const { render } = createTestRoot()
    render(<div style={{ width: 20, height: 20 }} />)
    expect(document.elementFromPoint(-5, 10)).toBeNull()
    expect(document.elementsFromPoint(5000, 10)).toEqual([])
  })

  it("skips pointer-events: none and visibility: hidden, and an element that left", () => {
    let behind: unknown
    let none: unknown
    let hidden: unknown
    const { render } = createTestRoot()
    render(
      <div style={{ width: 200, height: 200 }}>
        <div ref={(element) => (behind = element)} style={{ width: 100, height: 100 }} />
        <div
          ref={(element) => (none = element)}
          style={{ position: "absolute", left: 0, top: 0, width: 100, height: 100, pointerEvents: "none" }}
        />
        <div
          ref={(element) => (hidden = element)}
          style={{ position: "absolute", left: 0, top: 0, width: 100, height: 100, visibility: "hidden" }}
        />
      </div>
    )
    const found = document.elementsFromPoint(10, 10)
    expect(found).toContain(behind)
    expect(found).not.toContain(none)
    expect(found).not.toContain(hidden)
  })
})
