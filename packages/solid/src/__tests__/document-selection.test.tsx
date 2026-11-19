/** `document.getSelection` and `selectionchange` against the real test renderer. */
import { createSignal, Show } from "solid-js"
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
        <div style={{ fontSize: 20 }}>hello world</div>
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

describe.skipIf(!hasNativeTestRenderer)("Solid node selection", () => {
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
    const app = createTestRoot()
    cleanups.push(() => app.unmount())
    app.render(() => (
      <div style={{ padding: 20 }}>
        <p>elsewhere</p>
        <div contentEditable style={{ width: 200, height: 40 }}>
          <span>hello</span>
        </div>
      </div>
    ))
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

  it("follows a Solid text update and removal, and one selectionchange comes per burst", async () => {
    const [text, setText] = createSignal("hello world")
    const [before, setBefore] = createSignal(true)
    const app = createTestRoot()
    cleanups.push(() => app.unmount())
    app.render(() => (
      <div contentEditable style={{ width: 200, height: 40 }}>
        <Show when={before()}>
          <b>x</b>
        </Show>
        <span>{text()}</span>
      </div>
    ))
    const node = document.body!.querySelector("span")!.firstChild!
    const selection = document.getSelection()
    selection.setBaseAndExtent(node, 6, node, 11)
    expect(selection.toString()).toBe("world")
    const heard = listenForSelectionChange()
    await tick()
    // A listener added in the turn of the change hears it, as in Chrome: the burst below is the second.
    expect(heard.count()).toBe(1)

    setText("hello")
    setBefore(false)
    // The text is replaced whole, so a point inside it goes to the start, as the standard's "replace data" says.
    expect([selection.anchorOffset, selection.focusOffset]).toEqual([0, 0])
    expect(selection.type).toBe("Caret")
    await tick()
    expect(heard.count()).toBe(2)
  })

  it("is replaced by painted text that a drag selects, and replaces it", () => {
    const app = createTestRoot()
    cleanups.push(() => app.unmount())
    app.render(() => (
      <div style={{ display: "flex", flexDirection: "column", padding: 20 }}>
        <div style={{ fontSize: 20 }}>hello world</div>
      </div>
    ))
    const selection = document.getSelection()
    const text = document.body!.querySelector("div div")!.firstChild!
    selection.setBaseAndExtent(text, 0, text, 5)
    expect(selection.toString()).toBe("hello")

    expect(app.renderer.dragSelect(21, 30, 900, 30)).toBe("hello world")
    app.renderer.dispatchNativeEvents()
    expect(selection.anchorNode).toBeNull()
    expect(selection.toString()).toBe("hello world")

    selection.collapse(text, 1)
    app.renderer.dispatchNativeEvents()
    expect(app.renderer.getSelectedText()).toBeNull()
    expect(selection.type).toBe("Caret")
  })
})

