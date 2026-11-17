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
        <div style={{ fontSize: 20 }}>hello world</div>
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

describeNative("node selection", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  function listenForSelectionChange(): { count(): number } {
    let count = 0
    const listener = () => count++
    document.addEventListener("selectionchange", listener)
    cleanups.push(() => document.removeEventListener("selectionchange", listener))
    return { count: () => count }
  }

  it("focus() on an editing host puts a caret in its first text", () => {
    const { render, unmount } = createTestRoot()
    cleanups.push(unmount)
    render(
      <div style={{ padding: 20 }}>
        <p>elsewhere</p>
        <div contentEditable style={{ width: 200, height: 40 }}>
          <span>hello</span>
        </div>
      </div>
    )
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    const selection = document.getSelection()
    selection.collapse(document.body!.querySelector("p")!.firstChild, 2)
    host.focus()
    expect(document.activeElement).toBe(host)
    expect(selection.type).toBe("Caret")
    expect(selection.anchorNode).toBe(host.querySelector("span")!.firstChild)
    expect(selection.anchorOffset).toBe(0)
    selection.collapse(host.querySelector("span")!.firstChild, 3)
    host.blur()
    host.focus()
    expect(selection.anchorOffset).toBe(3)
  })

  it("follows a React text update and one selectionchange comes per burst", async () => {
    const { render, unmount } = createTestRoot()
    cleanups.push(unmount)
    const app = (text: string, before: boolean) => (
      <div contentEditable style={{ width: 200, height: 40 }}>
        {before ? <b>x</b> : null}
        <span>{text}</span>
      </div>
    )
    render(app("hello world", true))
    const span = document.body!.querySelector("span")!
    const text = span.firstChild!
    const selection = document.getSelection()
    selection.setBaseAndExtent(text, 6, text, 11)
    expect(selection.toString()).toBe("world")
    const heard = listenForSelectionChange()
    await tick()

    render(app("hello", true))
    render(app("hello", false))
    // The text is replaced whole, so a point inside it goes to the start, as the standard's "replace data" says.
    expect([selection.anchorOffset, selection.focusOffset]).toEqual([0, 0])
    expect(selection.type).toBe("Caret")
    await tick()
    expect(heard.count()).toBe(1)
  })

  it("modify() moves over the text of the document when the caret is not in an editing host", () => {
    const { render, unmount } = createTestRoot()
    cleanups.push(unmount)
    render(
      <div>
        <p>ab</p>
        <p>cd</p>
      </div>
    )
    const [first, second] = Array.from(document.body!.querySelectorAll("p")).map((p) => p.firstChild!)
    const selection = document.getSelection()
    selection.collapse(first, 2)
    selection.modify("move", "forward", "character")
    expect([selection.focusNode, selection.focusOffset]).toEqual([second, 0])
    selection.modify("extend", "forward", "word")
    expect([selection.anchorNode, selection.anchorOffset, selection.focusOffset]).toEqual([second, 0, 2])
  })

  it("is replaced by painted text that a drag selects, and replaces it", () => {
    const { render, renderer, unmount } = createTestRoot()
    cleanups.push(unmount)
    render(
      <div style={{ display: "flex", flexDirection: "column", padding: 20 }}>
        <div style={{ fontSize: 20 }}>hello world</div>
      </div>
    )
    const selection = document.getSelection()
    const text = document.body!.querySelector("div div")!.firstChild!
    selection.setBaseAndExtent(text, 0, text, 5)
    expect(selection.toString()).toBe("hello")

    expect(renderer.dragSelect(21, 30, 900, 30)).toBe("hello world")
    renderer.dispatchNativeEvents()
    expect(selection.anchorNode).toBeNull()
    expect(selection.type).toBe("Range")
    expect(selection.toString()).toBe("hello world")

    selection.collapse(text, 1)
    renderer.dispatchNativeEvents()
    expect(renderer.getSelectedText()).toBeNull()
    expect(selection.type).toBe("Caret")
    expect(selection.anchorNode).toBe(text)
  })
})

