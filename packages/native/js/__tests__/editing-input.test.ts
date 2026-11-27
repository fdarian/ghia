import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { hasLiveRanges, liveRangesAfterInsert, liveRangesBeforeRemove } from "../dom/live-ranges.js"
import { StaticRange } from "../dom/range.js"
import { runEditingComposition as composeIn, runEditingInput as inputIn } from "../editing/input.js"
import { ElementListeners } from "../events/element-listeners.js"
import { InputEvent } from "../events/classes.js"
import { document, window as ghiaWindow } from "../events/window-target.js"
import { defineDomMembers } from "../dom-members.js"
import { createRendererState } from "../renderer-state.js"
import type { NativeRenderer } from "../host.js"
import "../dom-globals.js"

/** The editing of the global window's document: these fixtures mount the one window. */
const runEditingInput = (inputType: string, data: string | null, options?: Parameters<typeof inputIn>[3]) => inputIn(document, inputType, data, options)
const runEditingComposition = (step: Parameters<typeof composeIn>[1], options?: Parameters<typeof composeIn>[2]) => composeIn(document, step, options)

class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeTx> = []
  /** A selection set inside an editing host focuses it; these fixtures have no focus to move. */
  focus(): void {}
  readonly listeners = new ElementListeners()

  constructor(
    readonly type: string,
    readonly props: Record<string, unknown> = {}
  ) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    return elementBinding(this)
  }
}

class FakeTx extends Text {
  parent: FakeEl | null = null

  constructor(public text: string) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    return {
      parent: this.parent as Node | null,
      children: [],
      connected: true,
      root: null,
      data: this.text,
      setData: (data) => {
        this.text = data
      },
      createText: (data) => new FakeTx(data) as unknown as Text,
    }
  }
}

function detach(node: FakeEl | FakeTx): void {
  const parent = node.parent
  if (parent === null) return
  const index = parent.kids.indexOf(node)
  if (hasLiveRanges()) liveRangesBeforeRemove(parent as unknown as Node, node as unknown as Node, index)
  parent.kids.splice(index, 1)
  node.parent = null
}

function elementBinding(element: FakeEl): ElementBinding {
  return {
    parent: element.parent as Node | null,
    children: element.kids as readonly Node[],
    connected: true,
    root: null,
    type: element.type,
    prop: (name) => element.props[name],
    propNames: () => Object.keys(element.props),
    style: {},
    assertSameWindow() {},
    insertBefore(child, before) {
      const node = child as unknown as FakeEl | FakeTx
      detach(node)
      const index = before === null ? element.kids.length : element.kids.indexOf(before as unknown as FakeEl)
      element.kids.splice(index, 0, node)
      node.parent = element
      if (hasLiveRanges()) liveRangesAfterInsert(element as unknown as Node, index, 1)
    },
    removeChild(child) {
      detach(child as unknown as FakeEl | FakeTx)
    },
    createText: (data) => new FakeTx(data) as unknown as Text,
  }
}

defineDomMembers(FakeEl.prototype, (element: FakeEl) => ({
  listeners: element.listeners,
  style: {},
  connected: true,
  layout: undefined,
  prop: (name) => element.props[name],
  propNames: () => Object.keys(element.props),
  setProp(name, value) {
    if (value === undefined) delete element.props[name]
    else element.props[name] = value
  },
}))

function el(type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = new FakeEl(type)
  for (const child of children) {
    child.parent = element
    element.kids.push(child)
  }
  return element
}

function editable(type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = el(type, ...children)
  element.props.contenteditable = "true"
  return element
}

const tx = (text: string) => new FakeTx(text)
const n = (node: FakeEl | FakeTx): Node => node as unknown as Node

class FakeWindow {
  applyBatch(): number[] {
    return []
  }
  getSelectedText(): string | null {
    return null
  }
  clearSelection(): void {}
  setWindowSelectionChange(): void {}
}

describe("editing input", () => {
  const selection = document.getSelection()
  const mounted: Array<{ detach(): boolean }> = []
  let active: FakeEl | undefined

  beforeEach(() => {
    mounted.push(createRendererState(new FakeWindow() as unknown as NativeRenderer).attach({ onSelectionChange: undefined }))
    active = undefined
    // A Text made through `document` belongs to the window mounted last, not the host's: the edit must use the host's binding.
    vi.spyOn(document, "createTextNode").mockImplementation(() => {
      throw new Error("document.createTextNode must not make the text of an edit")
    })
    vi.spyOn(document, "activeElement", "get").mockImplementation(() => (active ?? document.body) as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    selection.collapse(null)
    for (const binding of mounted.splice(0)) binding.detach()
  })

  function focus(host: FakeEl, node: FakeEl | FakeTx, offset: number): void {
    active = host
    selection.collapse(n(node), offset)
  }

  /** Logs every event type on the host, document and window, with the DOM text at the time. */
  function record(host: FakeEl, types: string[]): string[] {
    const log: string[] = []
    for (const type of types) {
      const listener = (event: Event) => {
        const input = event as InputEvent
        const where = event.currentTarget === host ? "host" : event.currentTarget === document ? "document" : "window"
        const detail = input.inputType === undefined ? "" : `[${input.inputType} ${JSON.stringify(input.data)} composing=${input.isComposing}]`
        log.push(`${type}@${where}${detail} text=${JSON.stringify(textOf(host))}`)
      }
      host.addEventListener(type, listener)
      document.addEventListener(type, listener as never)
      ghiaWindow.addEventListener(type, listener as never)
    }
    return log
  }

  function textOf(host: FakeEl): string {
    return host.kids.map((kid) => (kid instanceof FakeTx ? kid.text : textOf(kid))).join("")
  }

  describe("insertText", () => {
    it("fires beforeinput on the host, document and window, changes the DOM, moves the caret, then fires input", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, text, 1)
      const log = record(host, ["beforeinput", "input"])
      const result = runEditingInput("insertText", "X")
      expect(result).toEqual({ handled: true, canceled: false, changed: true })
      expect(text.text).toBe("aXb")
      expect([selection.anchorNode, selection.anchorOffset, selection.type]).toEqual([n(text), 2, "Caret"])
      expect(log).toEqual([
        'beforeinput@host[insertText "X" composing=false] text="ab"',
        'beforeinput@document[insertText "X" composing=false] text="ab"',
        'beforeinput@window[insertText "X" composing=false] text="ab"',
        'input@host[insertText "X" composing=false] text="aXb"',
        'input@document[insertText "X" composing=false] text="aXb"',
        'input@window[insertText "X" composing=false] text="aXb"',
      ])
    })

    it("gives beforeinput a bubbling, cancelable, composed event whose target range is the caret", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, text, 1)
      let seen: InputEvent | undefined
      let ranges: StaticRange[] = []
      host.addEventListener("beforeinput", (event) => {
        seen = event as InputEvent
        ranges = seen.getTargetRanges()
      })
      host.addEventListener("input", (event) => {
        expect((event as InputEvent).cancelable).toBe(false)
        expect((event as InputEvent).getTargetRanges()).toEqual([])
      })
      runEditingInput("insertText", "X")
      expect([seen?.bubbles, seen?.cancelable, seen?.composed, seen?.isTrusted]).toEqual([true, true, true, false])
      expect(ranges).toHaveLength(1)
      expect(ranges[0]).toBeInstanceOf(StaticRange)
      expect([ranges[0].startContainer, ranges[0].startOffset, ranges[0].collapsed]).toEqual([n(text), 1, true])
    })

    it("replaces a selected range first", () => {
      const a = tx("hello")
      const b = tx("world")
      const host = editable("div", a, b)
      active = host
      selection.setBaseAndExtent(n(a), 2, n(b), 2)
      const targets: string[] = []
      host.addEventListener("beforeinput", (event) => {
        const range = (event as InputEvent).getTargetRanges()[0]
        targets.push(`${range.startOffset}-${range.endOffset}`)
      })
      runEditingInput("insertText", "-")
      expect([a.text, b.text]).toEqual(["he-", "rld"])
      expect(targets).toEqual(["2-2"])
      expect([selection.anchorNode, selection.anchorOffset, selection.isCollapsed]).toEqual([n(a), 3, true])
    })

    it("types into the Text beside a caret that sits in an element, and makes a Text when there is none", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, host, 1)
      runEditingInput("insertText", "c")
      expect(text.text).toBe("abc")
      const empty = editable("div")
      focus(empty, empty, 0)
      runEditingInput("insertText", "x")
      runEditingInput("insertText", "y")
      expect(empty.kids.map((kid) => (kid as FakeTx).text)).toEqual(["xy"])
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(empty.kids[0]), 2])
    })

    it("types over a selection that spans two blocks into the block it began in, without a stray Text at the host", () => {
      const a = tx("hello")
      const b = tx("world")
      const host = editable("div", el("p", a), el("p", b))
      active = host
      selection.setBaseAndExtent(n(a), 2, n(b), 2)
      runEditingInput("insertText", "-")
      expect(a.text).toBe("he-")
      expect(b.text).toBe("rld")
      expect(host.kids).toHaveLength(2)
      expect([selection.anchorNode, selection.anchorOffset, selection.isCollapsed]).toEqual([n(a), 3, true])
    })

    it("a caret in an empty element gets a Text made by the host's binding", () => {
      const host = editable("div")
      focus(host, host, 0)
      runEditingInput("insertText", "q")
      expect(host.kids.map((kid) => (kid as FakeTx).text)).toEqual(["q"])
      expect(host.kids[0]).toBeInstanceOf(FakeTx)
    })

    it("changes nothing and fires no input when a beforeinput listener cancels", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, text, 1)
      const log = record(host, ["input"])
      host.addEventListener("beforeinput", (event) => event.preventDefault())
      expect(runEditingInput("insertText", "X")).toEqual({ handled: true, canceled: true, changed: false })
      expect(text.text).toBe("ab")
      expect(selection.anchorOffset).toBe(1)
      expect(log).toEqual([])
    })

    it("is not handled unless the host holds focus and the selection", () => {
      const text = tx("ab")
      const host = editable("div", text)
      selection.collapse(n(text), 1)
      expect(runEditingInput("insertText", "X").handled).toBe(false)
      active = el("div")
      expect(runEditingInput("insertText", "X").handled).toBe(false)
      active = host
      selection.collapse(null)
      expect(runEditingInput("insertText", "X").handled).toBe(false)
      const plain = tx("zz")
      const outside = el("div", plain)
      focus(host, plain, 0)
      expect(outside.kids).toHaveLength(1)
      expect(runEditingInput("insertText", "X").handled).toBe(false)
      expect(plain.text).toBe("zz")
    })
  })

  describe("deleteContent", () => {
    it("Backspace removes one grapheme, Delete the next one", () => {
      const text = tx("ab👨‍👩‍👧c")
      const host = editable("div", text)
      focus(host, text, text.text.length - 1)
      runEditingInput("deleteContentBackward", null)
      expect(text.text).toBe("abc")
      expect(selection.anchorOffset).toBe(2)
      runEditingInput("deleteContentForward", null)
      expect(text.text).toBe("ab")
      expect(selection.anchorOffset).toBe(2)
    })

    it("fires beforeinput with the range it deletes and input with the data null", () => {
      const text = tx("abc")
      const host = editable("div", text)
      focus(host, text, 2)
      const log = record(host, ["beforeinput", "input"])
      const targets: string[] = []
      host.addEventListener("beforeinput", (event) => {
        const range = (event as InputEvent).getTargetRanges()[0]
        targets.push(`${range.startOffset}-${range.endOffset}`)
      })
      runEditingInput("deleteContentBackward", null)
      expect(targets).toEqual(["1-2"])
      expect(log.filter((line) => line.includes("@host"))).toEqual([
        'beforeinput@host[deleteContentBackward null composing=false] text="abc"',
        'input@host[deleteContentBackward null composing=false] text="ac"',
      ])
    })

    it("steps into the previous Text at a Text edge, and deletes a selection whole", () => {
      const a = tx("ab")
      const b = tx("cd")
      const host = editable("div", a, el("b", b))
      focus(host, b, 0)
      runEditingInput("deleteContentBackward", null)
      expect([a.text, b.text]).toEqual(["a", "cd"])
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(a), 1])
      selection.setBaseAndExtent(n(a), 0, n(b), 1)
      runEditingInput("deleteContentForward", null)
      expect([a.text, b.text]).toEqual(["", "d"])
      expect(selection.isCollapsed).toBe(true)
    })

    it("Backspace and Delete next to a contenteditable=false element remove it whole", () => {
      const before = tx("ab")
      const inside = tx("island")
      const island = el("span", inside)
      island.props.contenteditable = "false"
      const after = tx("cd")
      const host = editable("div", before, island, after)
      focus(host, after, 0)
      const targets: string[] = []
      host.addEventListener("beforeinput", (event) => {
        const range = (event as InputEvent).getTargetRanges()[0]
        targets.push(`${range.startContainer === n(host) ? "host" : "?"}:${range.startOffset}-${range.endOffset}`)
      })
      expect(runEditingInput("deleteContentBackward", null)).toEqual({ handled: true, canceled: false, changed: true })
      expect(host.kids).toEqual([before, after])
      expect(inside.text).toBe("island")
      expect(targets).toEqual(["host:1-2"])
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(host), 1])

      const second = el("span", tx("x"))
      second.props.contenteditable = "false"
      host.kids.splice(1, 0, second)
      second.parent = host
      focus(host, before, 2)
      runEditingInput("deleteContentForward", null)
      expect(host.kids).toEqual([before, after])
    })

    it("fires beforeinput and nothing more at the edge of the host and over a block edge", () => {
      const a = tx("ab")
      const b = tx("cd")
      const host = editable("div", el("p", a), el("p", b))
      focus(host, a, 0)
      const log = record(host, ["beforeinput", "input"])
      expect(runEditingInput("deleteContentBackward", null)).toEqual({ handled: true, canceled: false, changed: false })
      focus(host, b, 0)
      expect(runEditingInput("deleteContentBackward", null).changed).toBe(false)
      expect([a.text, b.text]).toEqual(["ab", "cd"])
      expect(log.filter((line) => line.startsWith("input"))).toEqual([])
      expect(log.filter((line) => line.startsWith("beforeinput@host"))).toHaveLength(2)
    })
  })

  describe("paragraph and line breaks", () => {
    it("fire beforeinput and change nothing", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, text, 1)
      const log = record(host, ["beforeinput", "input"])
      expect(runEditingInput("insertParagraph", null).changed).toBe(false)
      expect(runEditingInput("insertLineBreak", null).changed).toBe(false)
      expect(text.text).toBe("ab")
      expect(log.filter((line) => line.includes("@host"))).toEqual([
        'beforeinput@host[insertParagraph null composing=false] text="ab"',
        'beforeinput@host[insertLineBreak null composing=false] text="ab"',
      ])
    })
  })

  describe("composition", () => {
    it("fires a beforeinput that cannot be canceled, and the change happens", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, text, 2)
      const seen: boolean[] = []
      host.addEventListener("beforeinput", (event) => {
        seen.push(event.cancelable)
        event.preventDefault()
      })
      runEditingComposition({ action: "mark", text: "k" })
      expect(seen).toEqual([false])
      expect(text.text).toBe("abk")
      runEditingComposition({ action: "unmark" })
      seen.length = 0
      runEditingInput("insertText", "z")
      expect(seen).toEqual([true])
      expect(text.text).toBe("abk")
    })

    it("keeps one composition per editing host", () => {
      const first = tx("ab")
      const firstHost = editable("div", first)
      const second = tx("cd")
      const secondHost = editable("div", second)
      focus(firstHost, first, 2)
      runEditingComposition({ action: "mark", text: "x" })
      focus(secondHost, second, 2)
      const types: string[] = []
      for (const type of ["compositionstart", "compositionend"]) secondHost.addEventListener(type, () => types.push(type))
      expect(runEditingComposition({ action: "unmark" })).toBe(false)
      runEditingComposition({ action: "mark", text: "y" })
      expect(types).toEqual(["compositionstart"])
      expect([first.text, second.text]).toEqual(["abx", "cdy"])
      runEditingComposition({ action: "unmark" })
      expect(types).toEqual(["compositionstart", "compositionend"])
    })

    it("runs compositionstart, beforeinput, compositionupdate, input per mark, and compositionend after the commit", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, text, 2)
      const events: string[] = []
      for (const type of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
        host.addEventListener(type, (event) => {
          const data = (event as InputEvent).data
          const composing = (event as InputEvent).isComposing
          events.push(`${type}${data === null ? "" : `:${data}`}${type === "beforeinput" || type === "input" ? `/${composing}` : ""} text=${textOf(host)}`)
        })
      }
      runEditingComposition({ action: "mark", text: "k" })
      runEditingComposition({ action: "mark", text: "ka" })
      runEditingComposition({ action: "commit", text: "か" })
      expect(events).toEqual([
        "compositionstart: text=ab",
        "beforeinput:k/true text=ab",
        "compositionupdate:k text=ab",
        "input:k/true text=abk",
        "beforeinput:ka/true text=abk",
        "compositionupdate:ka text=abk",
        "input:ka/true text=abka",
        "beforeinput:か/true text=abka",
        "compositionupdate:か text=abka",
        "input:か/true text=abか",
        "compositionend:か text=abか",
      ])
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(text), 3])
    })

    it("commits the marked text as it is and unmarks with compositionend alone", () => {
      const text = tx("ab")
      const host = editable("div", text)
      focus(host, text, 2)
      const types: string[] = []
      for (const type of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
        host.addEventListener(type, () => types.push(type))
      }
      runEditingComposition({ action: "mark", text: "x" })
      types.length = 0
      runEditingComposition({ action: "commit", text: "x" })
      expect(types).toEqual(["compositionend"])
      runEditingComposition({ action: "mark", text: "y" })
      types.length = 0
      runEditingComposition({ action: "unmark" })
      expect(types).toEqual(["compositionend"])
      expect(text.text).toBe("abxy")
      expect(runEditingComposition({ action: "unmark" })).toBe(false)
    })
  })
})

describe("InputEvent targetRanges", () => {
  it("has getTargetRanges returning a copy, empty by default", () => {
    const plain = new InputEvent("input")
    expect("getTargetRanges" in plain).toBe(true)
    expect(plain.getTargetRanges()).toEqual([])
    const range = new StaticRange({ startContainer: document, startOffset: 0, endContainer: document, endOffset: 0 })
    const event = new InputEvent("beforeinput", { targetRanges: [range] })
    const first = event.getTargetRanges()
    first.pop()
    expect(event.getTargetRanges()).toEqual([range])
  })
})
