/**
 * The placeholder pattern of Tiptap and ProseMirror: `p.is-empty::before { content: attr(data-placeholder) }` in an editing host. The
 * box is a virtual child of the paragraph (`layout::generated`) with text no DOM node holds, so a caret next to it never lands in that
 * text, typing goes into the paragraph, and nothing in the document sees the placeholder.
 */
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Native = { simulateKeyDown(key: string, held: boolean): void; simulateKeyUp(key: string): void }

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const SHEET = `.is-empty::before { content: attr(data-placeholder); float: left; height: 0; pointer-events: none; color: gray } p { margin: 0 }`

describeNative("an editing host with a placeholder box (React)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function open() {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    root.render(
      <div style={{ padding: 20 }}>
        <style>{SHEET}</style>
        <div contentEditable suppressContentEditableWarning style={{ width: 300, fontSize: 18 }}>
          <p className="is-empty" data-placeholder="Type something">
            <br />
          </p>
          <p className="is-empty" data-placeholder="Before the text">
            Hello
          </p>
        </div>
      </div>
    )
    const renderer = root.renderer
    renderer.setA11yActive(false)
    renderer.setInlineDraws(false)
    renderer.clockPause()
    const native = (renderer as unknown as { native: Native }).native
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    return { renderer, native, host }
  }

  async function frames(renderer: ReturnType<typeof open>["renderer"]) {
    for (let frame = 0; frame < 3; frame++) {
      await settle()
      renderer.drawFrame()
    }
  }

  it("types into the empty paragraph, and the placeholder is no part of the document", async () => {
    const { renderer, native, host } = open()
    host.focus()
    renderer.dispatchNativeEvents()
    const empty = host.children[0]!
    document.getSelection().collapse(empty, 0)
    await frames(renderer)
    for (const key of ["a", "b"]) {
      native.simulateKeyDown(key, false)
      renderer.dispatchNativeEvents()
      await settle()
      renderer.drawFrame()
      native.simulateKeyUp(key)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
    }
    expect(host.children[0]!.textContent).toBe("ab")
    expect(host.textContent).toBe("abHello")
    expect(renderer.getPaintedNodeSelection().caret, "the caret is painted").toBeTruthy()
  })

  it("keeps the caret in the text of a paragraph that has a box before it", async () => {
    const { renderer, native, host } = open()
    host.focus()
    renderer.dispatchNativeEvents()
    const text = host.children[1]!.firstChild!
    document.getSelection().collapse(text, 0)
    await frames(renderer)
    native.simulateKeyDown("x", false)
    renderer.dispatchNativeEvents()
    await settle()
    renderer.drawFrame()
    native.simulateKeyUp("x")
    renderer.dispatchNativeEvents()
    renderer.drawFrame()
    expect(host.children[1]!.textContent).toBe("xHello")
    const selection = document.getSelection()
    expect(selection.anchorNode).toBe(host.children[1]!.firstChild)
    expect(selection.anchorOffset).toBe(1)
  })
})
