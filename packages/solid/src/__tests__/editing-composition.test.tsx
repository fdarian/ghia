/** An input method composes in an editing host through the platform's input handler: the events in Chrome's order, the DOM it leaves, and what the handler answers the platform meanwhile. */
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("composing in an editing host (Solid)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function mount(lines: string[]) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    const [tick, setTick] = createSignal(0)
    root.render(() => (
      <div style={{ padding: 20, fontSize: 16, lineHeight: "20px", fontFamily: "Menlo" }}>
        <div style={{ height: 20 }}>{`tick ${tick()}`}</div>
        <div contenteditable style={{ width: 400, height: 300 }}>
          {lines.map((line) => (
            <div>{line}</div>
          ))}
        </div>
      </div>
    ))
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    const text = host.firstChild!.firstChild as Text | null
    root.renderer.setA11yActive(false)
    root.renderer.setInlineDraws(false)
    host.focus()
    document.getSelection().collapse(text ?? host.firstChild!, text?.data.length ?? 0)
    const id = root.renderer.getFocusedElementId()
    if (id === null) throw new Error("the host did not take focus")
    return { host, id, renderer: root.renderer, rerender: (value: number) => setTick(value) }
  }

  /** What the host hears, in order, as one string each. */
  function log(host: HTMLElement): string[] {
    const seen: string[] = []
    for (const type of ["keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
      host.addEventListener(type, (event) => {
        const e = event as KeyboardEvent & InputEvent & CompositionEvent
        if (type === "keydown" || type === "keyup") seen.push(`${type} ${e.key} composing=${e.isComposing}`)
        else if (type.startsWith("composition")) seen.push(`${type} "${e.data}"`)
        else seen.push(`${type} ${e.inputType} "${e.data}" composing=${e.isComposing} cancelable=${e.cancelable}`)
      })
    }
    return seen
  }

  const step = (key: string, text: string) => ({ key, action: "mark" as const, text })

  it("composes Japanese: the events of Chrome's order for each step, and the text it leaves", () => {
    const { host, id, renderer } = mount([""])
    const seen = log(host)
    renderer.simulateComposition(id, [step("k", "k"), step("a", "か"), step("n", "かn")])
    expect(host.textContent).toBe("かn")
    renderer.simulateComposition(id, [step("a", "かな"), { key: "Enter", action: "commit", text: "かな" }])
    expect(host.textContent).toBe("かな")
    const update = (text: string, key: string, composing: boolean) => [
      `keydown Process composing=${composing}`,
      `beforeinput insertCompositionText "${text}" composing=true cancelable=false`,
      `compositionupdate "${text}"`,
      `input insertCompositionText "${text}" composing=true cancelable=false`,
      `keyup ${key} composing=true`,
    ]
    expect(seen).toEqual([
      "keydown Process composing=false",
      'compositionstart ""',
      ...update("k", "k", false).slice(1),
      ...update("か", "a", true),
      ...update("かn", "n", true),
      ...update("かな", "a", true),
      "keydown Process composing=true",
      'compositionend "かな"',
      "keyup Enter composing=false",
    ])
    expect(document.getSelection().focusOffset).toBe(2)
  })

  it("a commit of other text than the marked one replaces it first", () => {
    const { host, id, renderer } = mount([""])
    const seen = log(host)
    renderer.simulateComposition(id, [step("k", "かな"), { key: "Space", action: "commit", text: "仮名" }])
    expect(host.textContent).toBe("仮名")
    expect(seen.filter((entry) => !entry.startsWith("key"))).toEqual([
      'compositionstart ""',
      'beforeinput insertCompositionText "かな" composing=true cancelable=false',
      'compositionupdate "かな"',
      'input insertCompositionText "かな" composing=true cancelable=false',
      'beforeinput insertCompositionText "仮名" composing=true cancelable=false',
      'compositionupdate "仮名"',
      'input insertCompositionText "仮名" composing=true cancelable=false',
      'compositionend "仮名"',
    ])
  })

  it("composes where the caret is, in text that was there, and puts the caret after what it committed", () => {
    const { host, id, renderer } = mount(["ab"])
    document.getSelection().collapse(host.firstChild!.firstChild, 1)
    renderer.simulateComposition(id, [step("k", "か"), { key: "Enter", action: "commit", text: "か" }])
    expect(host.textContent).toBe("aかb")
    const selection = document.getSelection()
    expect([selection.focusNode, selection.focusOffset]).toEqual([host.firstChild!.firstChild, 2])
  })

  it("replaces a selection with the composition", () => {
    const { host, id, renderer } = mount(["abcd"])
    const text = host.firstChild!.firstChild!
    document.getSelection().setBaseAndExtent(text, 1, text, 3)
    renderer.simulateComposition(id, [step("k", "か"), { key: "Enter", action: "commit", text: "か" }])
    expect(host.textContent).toBe("aかd")
  })

  it("a dead key is a one-character composition that the next key commits as one character", () => {
    const { host, id, renderer } = mount(["x"])
    const seen = log(host)
    renderer.simulateComposition(id, [step("Alt+e", "´"), { key: "e", action: "commit", text: "é" }])
    expect(host.textContent).toBe("xé")
    expect(seen).toEqual([
      "keydown Process composing=false",
      'compositionstart ""',
      'beforeinput insertCompositionText "´" composing=true cancelable=false',
      'compositionupdate "´"',
      'input insertCompositionText "´" composing=true cancelable=false',
      "keyup e composing=true",
      "keydown Process composing=true",
      'beforeinput insertCompositionText "é" composing=true cancelable=false',
      'compositionupdate "é"',
      'input insertCompositionText "é" composing=true cancelable=false',
      'compositionend "é"',
      "keyup e composing=false",
    ])
  })

  it("unmark ends the composition and keeps the text", () => {
    const { host, id, renderer } = mount([""])
    const seen = log(host)
    renderer.simulateComposition(id, [step("k", "か"), { key: "Enter", action: "unmark" }])
    expect(host.textContent).toBe("か")
    expect(seen.filter((entry) => entry.startsWith("composition"))).toEqual(['compositionstart ""', 'compositionupdate "か"', 'compositionend "か"'])
    // Typing goes on after it as plain text.
    renderer.simulateKeystrokes("x")
    expect(host.textContent).toBe("かx")
  })

  it("marking no text cancels the composition and its text", () => {
    const { host, id, renderer } = mount(["a"])
    const seen = log(host)
    renderer.simulateComposition(id, [step("k", "か"), { key: "Escape", action: "mark", text: "" }])
    expect(host.textContent).toBe("a")
    expect(seen.filter((entry) => entry.startsWith("composition")).slice(-2)).toEqual(['compositionupdate ""', 'compositionend ""'])
  })

  it("a keydown while composing is not an edit: Enter and Backspace are the input method's", () => {
    const { host, id, renderer } = mount([""])
    const seen = log(host)
    renderer.simulateComposition(id, [step("k", "かな")])
    // A key the input method handed back arrives as a plain keydown, but the composition runs, so it types nothing.
    renderer.simulateKeystrokes("Backspace")
    expect(host.textContent).toBe("かな")
    expect(seen.filter((entry) => entry.startsWith("beforeinput deleteContent"))).toEqual([])
  })

  it("the composition goes on across frames that replay the host and patch its paragraph", () => {
    const { host, id, renderer, rerender } = mount(["aa", "bb"])
    renderer.simulateComposition(id, [step("k", "k"), step("a", "か")])
    // Another part of the page changes: the host is replayed, not built.
    rerender(1)
    for (let frame = 0; frame < 3; frame++) renderer.drawFrame()
    renderer.simulateComposition(id, [step("n", "かn")])
    // The caret blinks: a frame that builds the paragraph holding it alone.
    renderer.advanceTime(500)
    renderer.drawFrame()
    renderer.advanceTime(500)
    renderer.drawFrame()
    const seen = log(host)
    renderer.simulateComposition(id, [step("a", "かな"), { key: "Enter", action: "commit", text: "かな" }])
    expect(host.firstChild!.textContent).toBe("aaかな")
    expect(seen.filter((entry) => entry.startsWith("composition"))).toEqual(['compositionupdate "かな"', 'compositionend "かな"'])
    expect(seen).toContain("keydown Process composing=true")
  })

  it("a selection that leaves the composition ends it: the next text is plain, and compositionend came first", () => {
    const { host, id, renderer } = mount(["abc"])
    const text = host.firstChild!.firstChild!
    document.getSelection().collapse(text, 3)
    renderer.simulateComposition(id, [step("k", "か")])
    expect(host.textContent).toBe("abcか")
    const seen = log(host)
    document.getSelection().collapse(text, 0)
    renderer.simulateKeystrokes("x")
    expect(host.textContent).toBe("xabcか")
    expect(seen).toEqual([
      "keydown x composing=false",
      'compositionend "か"',
      'beforeinput insertText "x" composing=false cancelable=true',
      'input insertText "x" composing=false cancelable=false',
      "keyup x composing=false",
    ])
  })

  it("losing focus ends the composition with compositionend", () => {
    const { host, id, renderer } = mount([""])
    renderer.simulateComposition(id, [step("k", "か")])
    const seen = log(host)
    host.blur()
    expect(seen).toEqual(['compositionend "か"'])
    expect(host.textContent).toBe("か")
  })

  it("answers the input method where the marked text is and which character a point is on", () => {
    const { host, id, renderer } = mount(["ab", "cd"])
    const first = host.firstChild!.firstChild as Text
    document.getSelection().collapse(first, 2)
    renderer.simulateComposition(id, [step("k", "かな")])
    expect(host.firstChild!.textContent).toBe("abかな")
    const caret = renderer.getInputMethodBounds(id, 4, 4)!
    const marked = renderer.getInputMethodBounds(id, 2, 4)!
    const start = renderer.getInputMethodBounds(id, 2, 2)!
    expect(start.width).toBe(0)
    expect(marked.x).toBeCloseTo(start.x, 3)
    expect(marked.width).toBeGreaterThan(0)
    expect(caret.x).toBeCloseTo(marked.x + marked.width, 1)
    // The point inside the second character of the marked text is the offset of that character.
    expect(renderer.getInputMethodIndexAtPoint(id, marked.x + marked.width * 0.75, marked.y + marked.height / 2)).toBe(3)
    expect(renderer.getInputMethodIndexAtPoint(id, marked.x + 1, marked.y + marked.height / 2)).toBe(2)
    // The paragraph under the caret is the whole of what the input method knows.
    const below = renderer.getInputMethodIndexAtPoint(id, marked.x + 1, marked.y + marked.height + 10)
    expect(below).toBeNull()
  })
})
