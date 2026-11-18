/// The keys that move the caret, extend the selection and delete by a word or a line in a focused editing host, as the default of an unprevented keydown (Chrome on macOS).
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const LINE = 20
const TEXT = { fontSize: 16, lineHeight: `${LINE}px`, fontFamily: "Menlo" } as const

function measureColumn(): number {
  const root = createTestRoot()
  root.render(() => (
    <div highlight={{ query: "aaaaaaaaaa" }}>
      <div style={TEXT}>{"aaaaaaaaaa"}</div>
    </div>
  ))
  const width = root.renderer.getPaintedHighlights()[0]!.rects[0]!.width / 10
  root.unmount()
  return width
}

describe.skipIf(!hasNativeTestRenderer)("the key moves of an editing host (Solid)", () => {
  const COLUMN = measureColumn()
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** A host of `lines` (one paragraph each) that is `columns` wide, with text outside it and a button to move focus to. */
  function mount(lines: string[], columns = 40) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    root.render(() => (
      <div style={{ padding: 20, ...TEXT }}>
        <div id="outside">outside text</div>
        <div contenteditable style={{ width: columns * COLUMN + 0.5 }}>
          {lines.map((line) => (
            <div>{line}</div>
          ))}
        </div>
        <button id="other">other</button>
      </div>
    ))
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    host.focus()
    const texts = [...host.children].map((child) => child.firstChild as Text)
    const selection = document.getSelection()
    return {
      host,
      texts,
      renderer: root.renderer,
      press: (keys: string) => root.renderer.simulateKeystrokes(keys),
      caret: (node: Node, offset: number) => selection.collapse(node, offset),
      state: () => [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset],
    }
  }

  /** Two paragraphs, the first wrapping after `bbbb `: rows `aaaa bbbb ` and `cccc dddd`, then `ee ff`. */
  const wrapped = () => mount(["aaaa bbbb cccc dddd", "ee ff"], 10)

  function log(host: HTMLElement, types: string[]) {
    const seen: string[] = []
    for (const type of types) {
      host.addEventListener(type, (event) => {
        const input = event as InputEvent
        if (input.inputType === undefined) {
          seen.push(type)
          return
        }
        const selection = document.getSelection()
        const range = input.getTargetRanges()[0]
        seen.push(
          `${type}:${input.inputType}:${input.cancelable}:${range === undefined ? "-" : `${range.startOffset}-${range.endOffset}`}:caret${selection.focusOffset}`
        )
      })
    }
    return seen
  }

  describe("Left and Right", () => {
    it("move by character, and Shift extends", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 3)
      press("ArrowRight")
      expect(state()).toEqual([texts[0], 4, texts[0], 4])
      press("ArrowLeft ArrowLeft")
      expect(state()).toEqual([texts[0], 2, texts[0], 2])
      press("Shift+ArrowRight Shift+ArrowRight Shift+ArrowRight")
      expect(state()).toEqual([texts[0], 2, texts[0], 5])
      press("Shift+ArrowLeft Shift+ArrowLeft Shift+ArrowLeft Shift+ArrowLeft")
      expect(state()).toEqual([texts[0], 2, texts[0], 1])
    })

    it("collapse a range to its start or its end without moving past it", () => {
      const { texts, caret, press, state } = wrapped()
      const selection = document.getSelection()
      caret(texts[0]!, 3)
      selection.setBaseAndExtent(texts[0]!, 3, texts[0]!, 8)
      press("ArrowLeft")
      expect(state()).toEqual([texts[0], 3, texts[0], 3])
      selection.setBaseAndExtent(texts[0]!, 8, texts[0]!, 3)
      press("ArrowRight")
      expect(state()).toEqual([texts[0], 8, texts[0], 8])
    })

    it("cross from one paragraph into the next, and stop at the edges of the host", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 19)
      press("ArrowRight")
      expect(state()).toEqual([texts[1], 0, texts[1], 0])
      press("ArrowLeft")
      expect(state()).toEqual([texts[0], 19, texts[0], 19])
      caret(texts[1]!, 5)
      press("ArrowRight")
      expect(state()).toEqual([texts[1], 5, texts[1], 5])
      caret(texts[0]!, 0)
      press("ArrowLeft")
      expect(state()).toEqual([texts[0], 0, texts[0], 0])
    })

    it("move by word with Option, and Shift extends", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 0)
      press("Alt+ArrowRight")
      expect(state()).toEqual([texts[0], 4, texts[0], 4])
      press("Alt+ArrowRight")
      expect(state()).toEqual([texts[0], 9, texts[0], 9])
      press("Alt+ArrowLeft")
      expect(state()).toEqual([texts[0], 5, texts[0], 5])
      press("Alt+Shift+ArrowRight")
      expect(state()).toEqual([texts[0], 5, texts[0], 9])
      press("Alt+Shift+ArrowLeft Alt+Shift+ArrowLeft")
      expect(state()).toEqual([texts[0], 5, texts[0], 0])
    })

    it("go to the start and end of the painted row with Command, and Shift extends", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 12)
      press("Meta+ArrowLeft")
      expect(state()).toEqual([texts[0], 10, texts[0], 10])
      press("Meta+ArrowRight")
      expect(state()).toEqual([texts[0], 19, texts[0], 19])
      caret(texts[0]!, 3)
      press("Meta+ArrowRight")
      expect(state()).toEqual([texts[0], 9, texts[0], 9])
      caret(texts[0]!, 12)
      press("Meta+Shift+ArrowLeft")
      expect(state()).toEqual([texts[0], 12, texts[0], 10])
    })
  })

  describe("Up and Down", () => {
    it("move by painted row through a wrapped paragraph and into the next, keeping the column", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 12)
      press("ArrowDown")
      expect(state()).toEqual([texts[1], 2, texts[1], 2])
      press("ArrowUp")
      expect(state()).toEqual([texts[0], 12, texts[0], 12])
      press("ArrowUp")
      expect(state()).toEqual([texts[0], 2, texts[0], 2])
    })

    it("keep the column across a shorter line, and Shift extends", () => {
      const { texts, caret, press, state } = mount(["the first line", "ab", "the third line"])
      caret(texts[0]!, 9)
      press("ArrowDown")
      expect(state()).toEqual([texts[1], 2, texts[1], 2])
      press("ArrowDown")
      expect(state()).toEqual([texts[2], 9, texts[2], 9])
      press("ArrowUp ArrowUp")
      expect(state()).toEqual([texts[0], 9, texts[0], 9])
      press("Shift+ArrowDown Shift+ArrowDown")
      expect(state()).toEqual([texts[0], 9, texts[2], 9])
    })

    it("collapse a range, then move from its end or its start", () => {
      const { texts, caret, press, state } = mount(["the first line", "ab", "the third line"])
      const selection = document.getSelection()
      caret(texts[0]!, 0)
      selection.setBaseAndExtent(texts[0]!, 3, texts[0]!, 8)
      press("ArrowDown")
      expect(state()).toEqual([texts[1], 2, texts[1], 2])
      selection.setBaseAndExtent(texts[2]!, 3, texts[2]!, 8)
      press("ArrowUp")
      expect(state()).toEqual([texts[1], 2, texts[1], 2])
    })

    it("go to the edge of the host's text on the last row", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[1]!, 1)
      press("ArrowDown")
      expect(state()).toEqual([texts[1], 5, texts[1], 5])
      caret(texts[0]!, 3)
      press("ArrowUp")
      expect(state()).toEqual([texts[0], 0, texts[0], 0])
    })

    it("go to the start and end of the host with Command, and Shift extends", () => {
      const { host, texts, caret, press, state } = wrapped()
      caret(texts[0]!, 12)
      press("Meta+ArrowDown")
      expect(state()).toEqual([texts[1], 5, texts[1], 5])
      press("Meta+ArrowUp")
      expect(state()).toEqual([texts[0], 0, texts[0], 0])
      caret(texts[0]!, 3)
      press("Meta+Shift+ArrowDown")
      expect(state()).toEqual([texts[0], 3, texts[1], 5])
      press("Meta+Shift+ArrowUp")
      expect(state()[2]).toBe(texts[0])
      expect(host.contains(document.getSelection().focusNode)).toBe(true)
    })
  })

  describe("Select all", () => {
    it("selects the editing host and nothing outside it", () => {
      const { host, texts, caret, press, state } = wrapped()
      caret(texts[0]!, 3)
      press("Meta+a")
      expect(state()).toEqual([host, 0, host, 2])
      const outside = document.getElementById("outside")!.firstChild!
      expect(document.getSelection().containsNode(outside, true)).toBe(false)
      expect(document.getSelection().containsNode(texts[1]!)).toBe(true)
    })

    it("is not Shift+Command+A", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 3)
      press("Meta+Shift+a")
      expect(state()).toEqual([texts[0], 3, texts[0], 3])
    })
  })

  describe("Home and End", () => {
    it("do not move the caret, as on macOS: they scroll", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 12)
      press("Home")
      expect(state()).toEqual([texts[0], 12, texts[0], 12])
      press("End")
      expect(state()).toEqual([texts[0], 12, texts[0], 12])
    })

    it("extend to the start and end of the host with Shift", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 12)
      press("Shift+Home")
      expect(state()).toEqual([texts[0], 12, texts[0], 0])
      press("Shift+End")
      expect(state()).toEqual([texts[0], 12, texts[1], 5])
    })
  })

  describe("the Emacs bindings", () => {
    it("Control+B, F, N and P move, and Shift extends", () => {
      const { texts, caret, press, state } = mount(["the first line", "ab", "the third line"])
      caret(texts[0]!, 4)
      press("Control+f Control+f")
      expect(state()).toEqual([texts[0], 6, texts[0], 6])
      press("Control+b")
      expect(state()).toEqual([texts[0], 5, texts[0], 5])
      press("Control+n")
      expect(state()).toEqual([texts[1], 2, texts[1], 2])
      press("Control+n")
      expect(state()).toEqual([texts[2], 5, texts[2], 5])
      press("Control+p Control+p")
      expect(state()).toEqual([texts[0], 5, texts[0], 5])
      press("Control+Shift+F Control+Shift+F")
      expect(state()).toEqual([texts[0], 5, texts[0], 7])
      press("Control+Shift+N")
      expect(state()[0]).toBe(texts[0])
      expect(state()[2]).toBe(texts[1])
    })

    it("Control+H and Control+D delete a character", () => {
      const { host, texts, caret, press } = mount(["abcdef"])
      const seen = log(host, ["beforeinput"])
      caret(texts[0]!, 3)
      press("Control+h")
      expect(host.textContent).toBe("abdef")
      press("Control+d")
      expect(host.textContent).toBe("abef")
      expect(seen).toEqual(["beforeinput:deleteContentBackward:true:2-3:caret3", "beforeinput:deleteContentForward:true:2-3:caret2"])
    })

    it("leaves Control+A and Control+E to the paragraph moves, which are not done", () => {
      const { texts, caret, press, state } = wrapped()
      caret(texts[0]!, 12)
      press("Control+a")
      expect(state()).toEqual([texts[0], 12, texts[0], 12])
      press("Control+e")
      expect(state()).toEqual([texts[0], 12, texts[0], 12])
    })
  })

  describe("deleting by a word or a line", () => {
    it("Option+Backspace is deleteWordBackward: targetRanges from the caret, the selection moved after beforeinput", () => {
      const { host, texts, caret, press, state } = mount(["hello brave world"])
      const seen = log(host, ["beforeinput", "input"])
      caret(texts[0]!, 11)
      press("Alt+Backspace")
      expect(seen).toEqual(["beforeinput:deleteWordBackward:true:6-11:caret11", "input:deleteWordBackward:false:-:caret6"])
      expect(host.textContent).toBe("hello  world")
      expect(state()).toEqual([texts[0], 6, texts[0], 6])
    })

    it("Option+Delete is deleteWordForward", () => {
      const { host, texts, caret, press, state } = mount(["hello brave world"])
      const seen = log(host, ["beforeinput"])
      caret(texts[0]!, 0)
      press("Alt+Delete")
      expect(seen).toEqual(["beforeinput:deleteWordForward:true:0-5:caret0"])
      expect(host.textContent).toBe(" brave world")
      expect(state()).toEqual([texts[0], 0, texts[0], 0])
    })

    it("Command+Backspace is deleteSoftLineBackward to the start of the painted row", () => {
      const { host, texts, caret, press, state } = wrapped()
      const seen = log(host, ["beforeinput"])
      caret(texts[0]!, 12)
      press("Meta+Backspace")
      expect(seen).toEqual(["beforeinput:deleteSoftLineBackward:true:10-12:caret12"])
      expect(host.firstElementChild!.textContent).toBe("aaaa bbbb cc dddd")
      expect(state()).toEqual([texts[0], 10, texts[0], 10])
    })

    it("Command+Delete has no binding on macOS", () => {
      const { host, texts, caret, press } = wrapped()
      const seen = log(host, ["beforeinput"])
      caret(texts[0]!, 12)
      press("Meta+Delete")
      expect(seen).toEqual([])
      expect(host.firstElementChild!.textContent).toBe("aaaa bbbb cccc dddd")
    })

    it("delete a selection with the word inputType", () => {
      const { host, texts, caret, press } = mount(["hello brave world"])
      const seen = log(host, ["beforeinput"])
      caret(texts[0]!, 0)
      document.getSelection().setBaseAndExtent(texts[0]!, 2, texts[0]!, 8)
      press("Alt+Backspace")
      expect(seen).toEqual(["beforeinput:deleteWordBackward:true:2-8:caret8"])
      expect(host.textContent).toBe("heave world")
    })

    it("tell the app and leave the paragraphs alone when the word is in the block before", () => {
      const { host, texts, caret, press, state } = wrapped()
      const seen = log(host, ["beforeinput", "input"])
      caret(texts[1]!, 0)
      press("Alt+Backspace")
      expect(seen).toEqual(["beforeinput:deleteWordBackward:true:15-0:caret0"])
      expect(host.textContent).toBe("aaaa bbbb cccc ddddee ff")
      expect(host.children).toHaveLength(2)
      expect(state()).toEqual([texts[1], 0, texts[1], 0])
    })

    it("do nothing when beforeinput is canceled", () => {
      const { host, texts, caret, press, state } = mount(["hello brave world"])
      host.addEventListener("beforeinput", (event) => event.preventDefault())
      caret(texts[0]!, 11)
      press("Alt+Backspace")
      expect(host.textContent).toBe("hello brave world")
      expect(state()).toEqual([texts[0], 11, texts[0], 11])
    })
  })

  describe("a prevented keydown", () => {
    it("does none of it", () => {
      const { host, texts, caret, press, state } = mount(["hello brave world", "second"])
      const seen = log(host, ["beforeinput"])
      host.addEventListener("keydown", (event) => event.preventDefault())
      caret(texts[0]!, 11)
      for (const key of ["ArrowRight", "Alt+ArrowLeft", "Meta+ArrowLeft", "ArrowDown", "Shift+ArrowRight", "Control+f", "Alt+Backspace", "Meta+Backspace", "Control+d", "Shift+Home"]) {
        press(key)
        expect(state()).toEqual([texts[0], 11, texts[0], 11])
      }
      press("Meta+a")
      expect(state()).toEqual([texts[0], 11, texts[0], 11])
      expect(seen).toEqual([])
      expect(host.textContent).toBe("hello brave worldsecond")
    })
  })

  describe("a focused element that is not an editing host", () => {
    it("is untouched by the keys", () => {
      const { host, texts, caret, press, state } = mount(["hello brave world"])
      const button = document.getElementById("other")!
      button.focus()
      const seen = log(host, ["beforeinput"])
      caret(texts[0]!, 5)
      for (const key of ["ArrowRight", "Alt+ArrowRight", "Meta+ArrowLeft", "Meta+a", "Alt+Backspace", "Meta+Backspace", "Control+f", "Shift+Home"]) {
        press(key)
        expect(state()).toEqual([texts[0], 5, texts[0], 5])
      }
      expect(seen).toEqual([])
      expect(host.textContent).toBe("hello brave world")
    })
  })
})
