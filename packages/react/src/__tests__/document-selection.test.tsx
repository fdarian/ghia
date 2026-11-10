/** `document.getSelection` and `selectionchange` against the real test renderer. */
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document, type DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("document.getSelection", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it("reads and clears a text selection, and sends selectionchange to document", () => {
    const { render, renderer } = createTestRoot()
    const seen: Array<string | undefined> = []
    const listener = (event: DomEvent) => seen.push(event.value)
    document.addEventListener("selectionchange", listener, { capture: true })
    cleanups.push(() => document.removeEventListener("selectionchange", listener, { capture: true }))
    render(
      <div style={{ display: "flex", flexDirection: "column", padding: 20 }}>
        <text style={{ fontSize: 20 }}>hello world</text>
      </div>
    )

    const selection = document.getSelection()
    expect(selection.rangeCount).toBe(0)
    expect(selection.type).toBe("None")

    expect(renderer.dragSelect(21, 30, 900, 30)).toBe("hello world")
    renderer.dispatchNativeEvents()
    expect(selection.rangeCount).toBe(1)
    expect(selection.isCollapsed).toBe(false)
    expect(selection.type).toBe("Range")
    expect(selection.toString()).toBe("hello world")
    expect(seen).toEqual(["hello world"])

    selection.removeAllRanges()
    renderer.dispatchNativeEvents()
    expect(selection.toString()).toBe("")
    expect(selection.rangeCount).toBe(0)
    expect(seen).toEqual(["hello world", undefined])
  })
})
