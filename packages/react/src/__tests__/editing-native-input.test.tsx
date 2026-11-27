/** Text reaches an editing host through the platform's input handler: once per key, in the frames that do not build the host, and never when a listener canceled it. */
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

// Under the retention verifier a frame builds everything it compares, so counts of patches mean nothing.
const counted = process.env.GPUIX_RETAIN_VERIFY === undefined && process.env.GPUIX_RETAIN_OFF === undefined

describeNative("the text input of an editing host (React)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** A host in a box of a fixed size, which is what a patch frame lays out again, with a sibling to change beside it. */
  function mount(lines: string[]) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    function App({ tick }: { tick: number }) {
      return (
        <div style={{ padding: 20, fontSize: 16, lineHeight: "20px", fontFamily: "Menlo" }}>
          <div data-tick={tick} style={{ height: 20 }}>{`tick ${tick}`}</div>
          <div contentEditable style={{ width: 400, height: 300 }}>
            {lines.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        </div>
      )
    }
    root.render(<App tick={0} />)
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    const line = host.firstChild!
    const text = line.firstChild as Text | null
    root.renderer.setA11yActive(false)
    root.renderer.setInlineDraws(false)
    host.focus()
    document.getSelection().collapse(text ?? line, text?.data.length ?? 0)
    return {
      host,
      renderer: root.renderer,
      rerender: (tick: number) => root.render(<App tick={tick} />),
    }
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

  it("inserts each typed key exactly once", () => {
    const { host, renderer } = mount([""])
    const seen = log(host, ["beforeinput", "input"])
    renderer.simulateKeystrokes("h e l l o")
    expect(host.textContent).toBe("hello")
    expect(seen).toEqual(["h", "e", "l", "l", "o"].flatMap((key) => [`beforeinput:insertText:${key}`, `input:insertText:${key}`]))
  })

  it("makes Enter one insertParagraph and types no line feed", () => {
    const { host, renderer } = mount(["ab"])
    const seen = log(host, ["beforeinput", "input"])
    renderer.simulateKeystrokes("Enter")
    expect(seen).toEqual(["beforeinput:insertParagraph:null"])
    expect(host.textContent).toBe("ab")
    renderer.simulateKeystrokes("Shift+Enter")
    expect(seen).toEqual(["beforeinput:insertParagraph:null", "beforeinput:insertLineBreak:null"])
    expect(host.textContent).toBe("ab")
  })

  it("deletes with Backspace and Delete, one beforeinput each", () => {
    const { host, renderer } = mount(["abcd"])
    const text = host.firstChild!.firstChild as Text
    const seen = log(host, ["beforeinput"])
    renderer.simulateKeystrokes("Backspace")
    expect(host.textContent).toBe("abc")
    document.getSelection().collapse(text, 0)
    renderer.simulateKeystrokes("Delete")
    expect(host.textContent).toBe("bc")
    expect(seen).toEqual(["beforeinput:deleteContentBackward:null", "beforeinput:deleteContentForward:null"])
  })

  it("inserts nothing for a key whose keydown was prevented", () => {
    const { host, renderer } = mount(["ab"])
    const seen = log(host, ["beforeinput", "input"])
    host.addEventListener("keydown", (event) => event.preventDefault())
    renderer.simulateKeystrokes("x Enter Backspace")
    expect([host.textContent, seen]).toEqual(["ab", []])
  })

  it("inserts nothing when beforeinput is canceled, and fires no input", () => {
    const { host, renderer } = mount(["ab"])
    const seen = log(host, ["beforeinput", "input"])
    host.addEventListener("beforeinput", (event) => event.preventDefault())
    renderer.simulateKeystrokes("x")
    expect([host.textContent, seen]).toEqual(["ab", ["beforeinput:insertText:x"]])
  })

  it("hears the key with no keydown listener on the path", () => {
    const { host, renderer } = mount([""])
    renderer.simulateKeystrokes("a")
    expect(host.textContent).toBe("a")
  })

  it("types into the host that holds focus and nowhere else", () => {
    const { host, renderer } = mount(["ab"])
    host.blur()
    renderer.simulateKeystrokes("x")
    expect(host.textContent).toBe("ab")
  })

  it("types in frames that replay the host and in frames that are patches of its paragraph", () => {
    const { host, renderer, rerender } = mount(["aa", "bb", "cc"])
    // Exercises the fallback: a caret the window cannot blink (composed window, effect group) is painted and ticked by the page.
    renderer.setPaintedCarets(true)
    renderer.simulateKeystrokes("x y")
    expect(host.firstChild!.textContent).toBe("aaxy")
    // Another part of the page changes: the host is replayed, not built.
    rerender(1)
    for (let frame = 0; frame < 3; frame++) renderer.drawFrame()
    renderer.simulateKeystrokes("z")
    expect(host.firstChild!.textContent).toBe("aaxyz")
    // The first change of phase of the caret is a frame built whole; the ones after it are patches that rebuild the paragraph that
    // holds the caret alone, and the handler the host registered is what the platform has still.
    renderer.advanceTime(500)
    renderer.drawFrame()
    const before = renderer.getPatchCounters().patchedFrames
    renderer.advanceTime(500)
    renderer.drawFrame()
    if (counted) expect(renderer.getPatchCounters().patchedFrames, "a blink is a patched frame").toBe(before + 1)
    renderer.simulateKeystrokes("w")
    expect(host.firstChild!.textContent).toBe("aaxyzw")
    renderer.advanceTime(500)
    renderer.drawFrame()
    renderer.simulateKeystrokes("v")
    expect(host.firstChild!.textContent).toBe("aaxyzwv")
  })
})
