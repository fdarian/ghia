/** `document.getSelection` and `selectionchange` against the real test renderer. */
import { afterEach, describe, expect, it } from "vitest"
import { document, type DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("Solid document.getSelection", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it("reads and clears a text selection, and sends selectionchange to document", () => {
    const app = createTestRoot()
    const seen: Array<string | undefined> = []
    const listener = (event: DomEvent) => seen.push(event.value)
    document.addEventListener("selectionchange", listener, { capture: true })
    cleanups.push(() => document.removeEventListener("selectionchange", listener, { capture: true }))
    app.render(() => (
      <div style={{ display: "flex", flexDirection: "column", padding: 20 }}>
        <text style={{ fontSize: 20 }}>hello world</text>
      </div>
    ))

    const selection = document.getSelection()
    expect(selection.rangeCount).toBe(0)
    expect(selection.type).toBe("None")

    expect(app.renderer.dragSelect(21, 30, 900, 30)).toBe("hello world")
    app.renderer.dispatchNativeEvents()
    expect(selection.rangeCount).toBe(1)
    expect(selection.type).toBe("Range")
    expect(selection.toString()).toBe("hello world")
    expect(seen).toEqual(["hello world"])

    selection.removeAllRanges()
    app.renderer.dispatchNativeEvents()
    expect(selection.toString()).toBe("")
    expect(seen).toEqual(["hello world", undefined])
  })
})
