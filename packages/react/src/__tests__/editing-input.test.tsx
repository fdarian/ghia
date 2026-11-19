/** Typing into a `<div contentEditable>`: keys, `beforeinput`, `input` and the DOM change between them. */
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("typing into an editing host", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function mount(text: string, caret: number) {
    const root = createTestRoot()
    cleanups.push(() => root.unmount())
    root.render(
      <div style={{ padding: 20 }}>
        <div contentEditable style={{ width: 200, height: 40 }}>
          <span>{text}</span>
        </div>
      </div>
    )
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    const node = host.querySelector("span")!.firstChild!
    host.focus()
    document.getSelection().collapse(node, caret)
    return { host, node, renderer: root.renderer }
  }

  function log(host: HTMLElement, types: string[]): string[] {
    const seen: string[] = []
    for (const type of types) {
      host.addEventListener(type, (event) => {
        const input = event as InputEvent
        seen.push(input.inputType === undefined ? type : `${type}:${input.inputType}:${input.data}`)
      })
    }
    return seen
  }

  it("types abc and Backspace removes one character", () => {
    const { host, node, renderer } = mount("hi", 2)
    renderer.simulateKeystrokes("a b c")
    expect(host.textContent).toBe("hiabc")
    const selection = document.getSelection()
    expect([selection.anchorNode, selection.anchorOffset, selection.type]).toEqual([node, 5, "Caret"])
    renderer.simulateKeystrokes("Backspace")
    expect(host.textContent).toBe("hiab")
    selection.collapse(node, 0)
    renderer.simulateKeystrokes("Delete Shift+Z")
    expect(host.textContent).toBe("Ziab")
  })

  it("fires keydown, beforeinput, input, keyup in order, with the key's text and a characterData record", () => {
    const { host, node, renderer } = mount("hi", 2)
    const seen = log(host, ["keydown", "beforeinput", "input", "keyup"])
    const observer = new MutationObserver(() => {})
    observer.observe(host, { characterData: true, subtree: true, characterDataOldValue: true })
    cleanups.push(() => observer.disconnect())
    renderer.simulateKeystrokes("x")
    expect(seen).toEqual(["keydown", "beforeinput:insertText:x", "input:insertText:x", "keyup"])
    expect(observer.takeRecords().map((record) => [record.type, record.target === node, record.oldValue])).toEqual([
      ["characterData", true, "hi"],
    ])
  })

  it("does nothing when keydown or beforeinput is canceled, and input does not fire", () => {
    const { host, renderer } = mount("hi", 2)
    const seen = log(host, ["beforeinput", "input"])
    let cancelKeydown = true
    host.addEventListener("keydown", (event) => {
      if (cancelKeydown) event.preventDefault()
    })
    renderer.simulateKeystrokes("a")
    expect([host.textContent, seen]).toEqual(["hi", []])
    cancelKeydown = false
    host.addEventListener("beforeinput", (event) => event.preventDefault())
    renderer.simulateKeystrokes("a")
    expect([host.textContent, seen]).toEqual(["hi", ["beforeinput:insertText:a"]])
  })

  it("maps Enter to insertParagraph and Shift+Enter to insertLineBreak, with no change to the text", () => {
    const { host, renderer } = mount("hi", 2)
    const seen = log(host, ["beforeinput", "input"])
    renderer.simulateKeystrokes("Enter Shift+Enter")
    expect(seen).toEqual(["beforeinput:insertParagraph:null", "beforeinput:insertLineBreak:null"])
    expect(host.textContent).toBe("hi")
  })

  it("leaves a command key to the shortcuts", () => {
    const { host, renderer } = mount("hi", 2)
    const seen = log(host, ["beforeinput"])
    renderer.simulateKeystrokes("Meta+a Control+b Alt+c")
    expect([host.textContent, seen]).toEqual(["hi", []])
  })

  it("does not type into an editing host that does not hold focus", () => {
    const { host, renderer } = mount("hi", 2)
    host.blur()
    renderer.simulateKeystrokes("a")
    expect(host.textContent).toBe("hi")
  })

  it("makes an edit without a key with simulateEditingInput", () => {
    const { host, renderer } = mount("hi", 1)
    const seen = log(host, ["keydown", "beforeinput", "input"])
    renderer.simulateEditingInput("insertText", "-")
    renderer.simulateEditingInput("deleteContentForward")
    expect(host.textContent).toBe("h-")
    expect(seen).toEqual([
      "beforeinput:insertText:-",
      "input:insertText:-",
      "beforeinput:deleteContentForward:null",
      "input:deleteContentForward:null",
    ])
    host.blur()
    expect(() => renderer.simulateEditingInput("insertText", "x")).toThrow(/focused editing host/)
  })

  it("runs a composition with simulateEditingComposition", () => {
    const { host, renderer } = mount("hi", 2)
    const seen: string[] = []
    for (const type of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
      host.addEventListener(type, (event) => {
        const data = (event as InputEvent).data
        seen.push(`${type}:${data}:${(event as InputEvent).isComposing ?? ""}`)
      })
    }
    renderer.simulateEditingComposition([
      { action: "mark", text: "n" },
      { action: "mark", text: "ni" },
      { action: "commit", text: "你" },
    ])
    expect(host.textContent).toBe("hi你")
    expect(seen).toEqual([
      "compositionstart::",
      "beforeinput:n:true",
      "compositionupdate:n:",
      "input:n:true",
      "beforeinput:ni:true",
      "compositionupdate:ni:",
      "input:ni:true",
      "beforeinput:你:true",
      "compositionupdate:你:",
      "input:你:true",
      "compositionend:你:",
    ])
  })

  it("Backspace and Delete next to a contentEditable=\"false\" element remove it whole", () => {
    const root = createTestRoot()
    cleanups.push(() => root.unmount())
    root.render(
      <div contentEditable style={{ width: 200, height: 40 }}>
        <span>ab</span>
        <b contentEditable="false">tag</b>
        <span>cd</span>
      </div>
    )
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    host.focus()
    const selection = document.getSelection()
    selection.collapse(host.lastElementChild!.firstChild!, 0)
    root.renderer.simulateKeystrokes("Backspace")
    expect(host.querySelector("b")).toBeNull()
    expect(host.textContent).toBe("abcd")
    expect([selection.anchorNode, selection.anchorOffset, selection.type]).toEqual([host, 1, "Caret"])
  })
})
