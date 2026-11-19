import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { EventPayload } from "../../index.js"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { hasLiveRanges, liveRangesAfterInsert, liveRangesBeforeRemove } from "../dom/live-ranges.js"
import { Range, StaticRange } from "../dom/range.js"
import { holdsNodeSelection, placeCaretInEditingHost } from "../dom/selection.js"
import { document, syncWindowSelectionChange, window as ghiaWindow } from "../events/window-target.js"
import { defineDomMembers } from "../dom-members.js"
import { createRendererState } from "../renderer-state.js"
import type { NativeRenderer } from "../host.js"
import "../dom-globals.js"

/** A tree that is in the document, kept the way an adapter keeps one: live range hooks run where a child leaves or is placed. */
class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeTx> = []
  /** A selection set inside an editing host focuses it; these fixtures have no focus to move. */
  focus(): void {}

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
  connected = true

  constructor(public text: string) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    return {
      parent: this.parent as Node | null,
      children: [],
      connected: this.connected,
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
  listeners: undefined as never,
  style: {},
  connected: true,
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

/** A Text that is in no document. */
function stray(): FakeTx {
  const text = new FakeTx("stray")
  text.connected = false
  return text
}

function tx(text: string): FakeTx {
  return new FakeTx(text)
}

const n = (node: FakeEl | FakeTx): Node => node as unknown as Node

function errorName(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof DOMException) return error.name
    throw error
  }
  return "no error"
}

class FakeWindow {
  selected: string | null = null
  clears = 0
  selectionChangeCalls: Array<[boolean, number]> = []

  applyBatch(): number[] {
    return []
  }

  getSelectedText(): string | null {
    return this.selected
  }

  clearSelection(): void {
    this.clears++
    this.selected = null
  }

  setWindowSelectionChange(enabled: boolean, eventId: number): void {
    this.selectionChangeCalls.push([enabled, eventId])
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("node Selection", () => {
  const mounted: Array<{ detach(): boolean }> = []
  const selection = document.getSelection()

  beforeEach(() => {
    mountWindow()
  })

  afterEach(() => {
    selection.collapse(null)
    for (const binding of mounted.splice(0)) binding.detach()
  })

  function mountWindow() {
    const fake = new FakeWindow()
    const state = createRendererState(fake as unknown as NativeRenderer)
    const binding = state.attach({ onSelectionChange: undefined })
    mounted.push(binding)
    return { fake, eventId: binding.windowSelectionEventId, state }
  }

  function describeSelection(names: Map<unknown, string>): string {
    return `${names.get(selection.anchorNode)}:${selection.anchorOffset}>${names.get(selection.focusNode)}:${selection.focusOffset}`
  }

  describe("answers", () => {
    it("reports the anchor and focus of a forward and a backward selection", () => {
      const a = tx("hello")
      const b = tx("world")
      const root = el("div", a, el("p", b))
      const names = new Map<unknown, string>([[n(a), "a"], [n(b), "b"]])
      selection.setBaseAndExtent(n(a), 1, n(b), 2)
      expect(describeSelection(names)).toBe("a:1>b:2")
      expect([selection.rangeCount, selection.type, selection.direction, selection.isCollapsed]).toEqual([1, "Range", "forwards", false])
      expect(selection.toString()).toBe("ellowo")
      selection.setBaseAndExtent(n(b), 2, n(a), 1)
      expect(describeSelection(names)).toBe("b:2>a:1")
      expect(selection.direction).toBe("backwards")
      expect(selection.getRangeAt(0).startContainer).toBe(n(a))
      expect(root.kids).toHaveLength(2)
    })

    it("is a Caret when collapsed, with direction none", () => {
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 3)
      expect([selection.type, selection.isCollapsed, selection.direction, selection.rangeCount]).toEqual(["Caret", true, "none", 1])
      expect([selection.anchorOffset, selection.focusOffset]).toEqual([3, 3])
      expect(selection.toString()).toBe("")
    })

    it("answers null, 0 and none with nothing selected", () => {
      mountWindow()
      expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([null, 0, null, 0])
      expect([selection.type, selection.direction, selection.rangeCount]).toEqual(["None", "none", 0])
      expect(selection.getComposedRanges()).toEqual([])
    })

    it("getRangeAt returns the selection's own live Range: changing it changes the selection", () => {
      const a = tx("hello")
      el("div", a)
      selection.setBaseAndExtent(n(a), 0, n(a), 2)
      const range = selection.getRangeAt(0)
      expect(range).toBeInstanceOf(Range)
      expect(selection.getRangeAt(0)).toBe(range)
      range.setEnd(n(a), 5)
      expect([selection.anchorOffset, selection.focusOffset]).toEqual([0, 5])
      expect(selection.toString()).toBe("hello")
      range.collapse(true)
      expect([selection.type, selection.focusOffset]).toEqual(["Caret", 0])
      range.selectNodeContents(n(a))
      expect(selection.toString()).toBe("hello")
    })

    it("keeps the Range through tree changes, and a method that sets the selection anew hands out another", () => {
      const a = tx("hello")
      const b = tx("world")
      const root = el("div", a, b)
      selection.setBaseAndExtent(n(b), 1, n(b), 3)
      const range = selection.getRangeAt(0)
      n(root).removeChild(n(a))
      n(b).insertData(0, "XX")
      expect(selection.getRangeAt(0)).toBe(range)
      expect([range.startOffset, range.endOffset]).toEqual([3, 5])
      selection.setBaseAndExtent(n(b), 0, n(b), 2)
      const next = selection.getRangeAt(0)
      expect(next).not.toBe(range)
      next.setEnd(n(b), 4)
      expect(selection.focusOffset).toBe(4)
      expect([range.startOffset, range.endOffset]).toEqual([3, 5])
    })

    it("a Range the selection let go of no longer adjusts or announces anything", async () => {
      const a = tx("hello")
      const root = el("div", a)
      selection.setBaseAndExtent(n(a), 1, n(a), 4)
      const stale = selection.getRangeAt(0)
      selection.removeAllRanges()
      selection.collapse(n(a), 0)
      const live = selection.getRangeAt(0)
      await tick()
      const seen: string[] = []
      const listener = () => seen.push("selectionchange")
      document.addEventListener("selectionchange", listener)
      try {
        n(a).insertData(0, "ab")
        stale.setStart(n(a), 0)
        n(root).removeChild(n(a))
        await tick()
      } finally {
        document.removeEventListener("selectionchange", listener)
      }
      // The live range sat in `a`, which left: one event for it; the stale range's changes added none and nothing threw.
      expect(seen).toEqual(["selectionchange"])
      expect(selection.getRangeAt(0)).toBe(live)
      expect(() => selection.removeRange(live)).not.toThrow()
      expect(errorName(() => selection.removeRange(stale))).toBe("NotFoundError")
    })

    it("changing the held Range queues selectionchange", async () => {
      const a = tx("hello")
      el("div", a)
      selection.setBaseAndExtent(n(a), 0, n(a), 2)
      const range = selection.getRangeAt(0)
      await tick()
      const seen: string[] = []
      const listener = () => seen.push("selectionchange")
      document.addEventListener("selectionchange", listener)
      try {
        range.setEnd(n(a), 4)
        range.setEnd(n(a), 5)
        await tick()
        range.setEnd(n(a), 5)
        await tick()
      } finally {
        document.removeEventListener("selectionchange", listener)
      }
      expect(seen).toEqual(["selectionchange"])
    })

    it("getComposedRanges gives one StaticRange", () => {
      const a = tx("hello")
      el("div", a)
      selection.setBaseAndExtent(n(a), 1, n(a), 4)
      const [range] = selection.getComposedRanges()
      expect(range).toBeInstanceOf(StaticRange)
      expect([range.startOffset, range.endOffset]).toEqual([1, 4])
      expect(selection.getComposedRanges({ shadowRoots: [] } as never)).toHaveLength(1)
    })
  })

  describe("changes", () => {
    it("collapse and setPosition, with null clearing the selection", () => {
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 2)
      selection.setPosition(n(a), 4)
      expect(selection.focusOffset).toBe(4)
      selection.collapse(n(a))
      expect(selection.focusOffset).toBe(0)
      selection.collapse(null)
      expect(selection.rangeCount).toBe(0)
    })

    it("collapseToStart and collapseToEnd", () => {
      const a = tx("hello")
      el("div", a)
      selection.setBaseAndExtent(n(a), 4, n(a), 1)
      selection.collapseToStart()
      expect([selection.anchorOffset, selection.isCollapsed]).toEqual([1, true])
      selection.setBaseAndExtent(n(a), 1, n(a), 4)
      selection.collapseToEnd()
      expect([selection.focusOffset, selection.isCollapsed]).toEqual([4, true])
    })

    it("extend moves the focus and keeps the anchor, across the anchor too", () => {
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 2)
      selection.extend(n(a), 4)
      expect([selection.anchorOffset, selection.focusOffset, selection.direction]).toEqual([2, 4, "forwards"])
      selection.extend(n(a), 0)
      expect([selection.anchorOffset, selection.focusOffset, selection.direction]).toEqual([2, 0, "backwards"])
      selection.extend(n(a), 3)
      expect([selection.anchorOffset, selection.focusOffset, selection.direction]).toEqual([2, 3, "forwards"])
    })

    it("selectAllChildren of a Text ends at its child count, 0", () => {
      const a = tx("hello")
      el("div", a)
      selection.selectAllChildren(n(a))
      expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([n(a), 0, n(a), 0])
      expect(selection.type).toBe("Caret")
    })

    it("selectAllChildren selects the contents of a node", () => {
      const a = tx("one")
      const b = tx("two")
      const root = el("div", a, b)
      selection.selectAllChildren(n(root))
      expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([n(root), 0, n(root), 2])
      expect(selection.toString()).toBe("onetwo")
    })

    it("addRange takes the boundaries of a range and is ignored while a node range exists", () => {
      const a = tx("hello")
      el("div", a)
      const range = new Range()
      range.setStart(n(a), 1)
      range.setEnd(n(a), 3)
      selection.addRange(range)
      expect(selection.getRangeAt(0)).toBe(range)
      range.setEnd(n(a), 4)
      expect(selection.toString()).toBe("ell")
      range.setEnd(n(a), 3)
      const other = new Range()
      other.setStart(n(a), 0)
      other.setEnd(n(a), 5)
      selection.addRange(other)
      expect(selection.toString()).toBe("el")
    })

    it("addRange ignores a range outside the document", () => {
      const range = new Range()
      range.setStart(n(stray()), 0)
      selection.addRange(range)
      expect(selection.rangeCount).toBe(0)
    })

    it("removeRange removes the range it handed over", () => {
      const a = tx("hello")
      el("div", a)
      selection.setBaseAndExtent(n(a), 0, n(a), 2)
      selection.removeRange(selection.getRangeAt(0))
      expect(selection.rangeCount).toBe(0)
    })

    it("deleteFromDocument removes the selected text and leaves a caret", () => {
      const a = tx("hello")
      el("div", a)
      selection.setBaseAndExtent(n(a), 1, n(a), 4)
      selection.deleteFromDocument()
      expect(a.text).toBe("ho")
      expect([selection.type, selection.focusOffset]).toEqual(["Caret", 1])
    })

    it("containsNode: whole nodes, and parts with allowPartialContainment", () => {
      const a = tx("hello")
      const b = tx("world")
      const c = tx("again")
      const root = el("div", a, b, c)
      selection.setBaseAndExtent(n(a), 3, n(b), 5)
      expect(selection.containsNode(n(b))).toBe(true)
      expect(selection.containsNode(n(a))).toBe(false)
      expect(selection.containsNode(n(a), true)).toBe(true)
      expect(selection.containsNode(n(c), true)).toBe(false)
      expect(selection.containsNode(n(root), true)).toBe(true)
      expect(selection.containsNode(n(root))).toBe(false)
      expect(selection.containsNode(n(stray()))).toBe(false)
    })

    it("containsNode with allowPartialContainment counts a node whose edge is exactly a boundary point", () => {
      const a = tx("hello")
      const b = tx("world")
      const c = tx("again")
      el("div", a, b, c)
      selection.setBaseAndExtent(n(a), 5, n(b), 0)
      expect(selection.containsNode(n(a), true)).toBe(true)
      expect(selection.containsNode(n(b), true)).toBe(true)
      expect(selection.containsNode(n(c), true)).toBe(false)
      expect(selection.containsNode(n(a))).toBe(false)
    })

    it("a node outside the document leaves the selection as it was", () => {
      const a = tx("hello")
      el("div", a)
      const outside = stray()
      selection.collapse(n(a), 1)
      selection.collapse(n(outside), 0)
      selection.setBaseAndExtent(n(a), 0, n(outside), 0)
      selection.selectAllChildren(n(outside))
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(a), 1])
    })
  })

  describe("errors", () => {
    it("getRangeAt: IndexSizeError for no range and for an index but 0", () => {
      mountWindow()
      expect(errorName(() => selection.getRangeAt(0))).toBe("IndexSizeError")
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 1)
      expect(errorName(() => selection.getRangeAt(1))).toBe("IndexSizeError")
    })

    it("an offset past the length is an IndexSizeError", () => {
      const a = tx("hello")
      el("div", a)
      expect(errorName(() => selection.collapse(n(a), 6))).toBe("IndexSizeError")
      expect(errorName(() => selection.setBaseAndExtent(n(a), 0, n(a), 6))).toBe("IndexSizeError")
      expect(errorName(() => selection.setBaseAndExtent(n(a), 6, n(a), 0))).toBe("IndexSizeError")
      selection.collapse(n(a), 1)
      expect(errorName(() => selection.extend(n(a), 9))).toBe("IndexSizeError")
    })

    it("removeRange: NotFoundError for a range that is not the selection's", () => {
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 1)
      expect(errorName(() => selection.removeRange(new Range()))).toBe("NotFoundError")
    })

    it("collapseToStart, collapseToEnd and extend: InvalidStateError with no range", () => {
      mountWindow()
      const a = tx("hello")
      el("div", a)
      expect(errorName(() => selection.collapseToStart())).toBe("InvalidStateError")
      expect(errorName(() => selection.collapseToEnd())).toBe("InvalidStateError")
      expect(errorName(() => selection.extend(n(a), 0))).toBe("InvalidStateError")
    })

    it("a value that is not a node or a range is a TypeError", () => {
      expect(() => selection.collapse({} as never)).toThrow(TypeError)
      expect(() => selection.setBaseAndExtent(null as never, 0, null as never, 0)).toThrow(TypeError)
      expect(() => selection.selectAllChildren(null as never)).toThrow(TypeError)
      expect(() => selection.containsNode(null as never)).toThrow(TypeError)
      expect(() => selection.addRange({} as never)).toThrow(TypeError)
      expect(() => selection.removeRange({} as never)).toThrow(TypeError)
    })
  })

  describe("live range", () => {
    it("follows what the tree does", () => {
      const a = tx("hello")
      const b = tx("world")
      const root = el("div", a, b)
      selection.setBaseAndExtent(n(a), 4, n(b), 2)
      n(a).deleteData(0, 2)
      expect(selection.anchorOffset).toBe(2)
      n(root).removeChild(n(a))
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(root), 0])
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(b), 2])
    })
  })

  describe("selectionchange", () => {
    function listen(): { events: Event[]; stop(): void } {
      const events: Event[] = []
      const listener = (event: Event) => events.push(event)
      document.addEventListener("selectionchange", listener)
      return { events, stop: () => document.removeEventListener("selectionchange", listener) }
    }

    it("is one task per burst of changes, at document, not bubbling and not cancelable", async () => {
      const a = tx("hello")
      el("div", a)
      const heard = listen()
      try {
        selection.collapse(n(a), 1)
        selection.extend(n(a), 3)
        selection.collapseToEnd()
        expect(heard.events).toHaveLength(0)
        await tick()
        expect(heard.events).toHaveLength(1)
        expect(heard.events[0].type).toBe("selectionchange")
        expect([heard.events[0].target, heard.events[0].bubbles, heard.events[0].cancelable]).toEqual([document, false, false])
        selection.collapse(n(a), 2)
        await tick()
        expect(heard.events).toHaveLength(2)
      } finally {
        heard.stop()
      }
    })

    it("reaches window in the capture phase only", async () => {
      const a = tx("hello")
      el("div", a)
      const seen: string[] = []
      const capture = () => seen.push("capture")
      const bubble = () => seen.push("bubble")
      ghiaWindow.addEventListener("selectionchange", capture, { capture: true })
      ghiaWindow.addEventListener("selectionchange", bubble)
      try {
        selection.collapse(n(a), 1)
        await tick()
      } finally {
        ghiaWindow.removeEventListener("selectionchange", capture, { capture: true })
        ghiaWindow.removeEventListener("selectionchange", bubble)
      }
      expect(seen).toEqual(["capture"])
    })

    it("is sent to a listener added after the change in the same turn, as Chrome does", async () => {
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 1)
      const heard = listen()
      try {
        await tick()
        expect(heard.events).toHaveLength(1)
      } finally {
        heard.stop()
      }
    })

    it("is not sent for a change that changes nothing", async () => {
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 1)
      await tick()
      const heard = listen()
      try {
        selection.collapse(n(a), 1)
        await tick()
        expect(heard.events).toHaveLength(0)
      } finally {
        heard.stop()
      }
    })

    it("is sent when a tree change moves the range, and when it is removed", async () => {
      const a = tx("hello")
      const b = tx("world")
      const root = el("div", a, b)
      selection.collapse(n(b), 3)
      await tick()
      const heard = listen()
      try {
        n(root).removeChild(n(a))
        await tick()
        expect(heard.events).toHaveLength(0)
        n(b).deleteData(0, 2)
        await tick()
        expect(heard.events).toHaveLength(1)
        selection.removeAllRanges()
        await tick()
        expect(heard.events).toHaveLength(2)
      } finally {
        heard.stop()
      }
    })
  })

  describe("with painted text", () => {
    it("a node selection clears the painted one", () => {
      const { fake } = mountWindow()
      const a = tx("hello")
      el("div", a)
      fake.selected = "painted"
      selection.collapse(n(a), 1)
      expect(fake.clears).toBe(1)
      expect(fake.selected).toBeNull()
      expect(selection.type).toBe("Caret")
    })

    it("a node selection leaves a window with no painted text alone", () => {
      const { fake } = mountWindow()
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 1)
      expect(fake.clears).toBe(0)
    })

    it("painted text that native reports replaces the node range, and a clear does not", () => {
      const { fake, eventId, state } = mountWindow()
      const a = tx("hello")
      el("div", a)
      selection.setBaseAndExtent(n(a), 0, n(a), 2)
      const seen: string[] = []
      const listener = () => seen.push("selectionchange")
      document.addEventListener("selectionchange", listener)
      try {
        const clear: EventPayload = { elementId: eventId, eventType: "selectionChange" }
        expect(state.dispatch(clear)).toBe(true)
        expect(selection.getRangeAt(0).startContainer).toBe(n(a))
        fake.selected = "painted"
        const painted: EventPayload = { elementId: eventId, eventType: "selectionChange", value: "painted" }
        expect(state.dispatch(painted)).toBe(true)
      } finally {
        document.removeEventListener("selectionchange", listener)
      }
      expect(holdsNodeSelection()).toBe(false)
      expect(seen).toEqual(["selectionchange", "selectionchange"])
      expect([selection.anchorNode, selection.rangeCount, selection.type, selection.toString()]).toEqual([null, 1, "Range", "painted"])
    })

    it("asks native for selectionChange while a node range is held", () => {
      const { fake, eventId } = mountWindow()
      const sync = syncWindowSelectionChange(fake, eventId, () => false)
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 1)
      selection.collapse(null)
      sync.stop()
      expect(fake.selectionChangeCalls).toEqual([
        [false, eventId],
        [true, eventId],
        [false, eventId],
        [false, eventId],
      ])
    })

    it("removeAllRanges clears both", () => {
      const { fake } = mountWindow()
      const a = tx("hello")
      el("div", a)
      selection.collapse(n(a), 1)
      fake.selected = "painted"
      selection.removeAllRanges()
      expect(fake.clears).toBe(1)
      expect(selection.rangeCount).toBe(0)
    })

    it("getRangeAt on painted text is a NotSupportedError", () => {
      const { fake } = mountWindow()
      fake.selected = "painted"
      expect(errorName(() => selection.getRangeAt(0))).toBe("NotSupportedError")
    })
  })

  describe("focus on an editing host", () => {
    it("puts a caret at the first Text of the host when the selection is elsewhere", () => {
      const a = tx("hello")
      const b = tx("elsewhere")
      const host = editable("div", el("p", a))
      el("div", b)
      selection.collapse(n(b), 2)
      placeCaretInEditingHost(host as unknown as never)
      expect([selection.anchorNode, selection.anchorOffset, selection.type]).toEqual([n(a), 0, "Caret"])
    })

    it("puts it at (host, 0) when the host has no text, and keeps a selection already inside", () => {
      const host = editable("div", el("p"))
      placeCaretInEditingHost(host as unknown as never)
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(host), 0])
      const a = tx("hello")
      const filled = editable("div", a)
      selection.setBaseAndExtent(n(a), 2, n(a), 4)
      placeCaretInEditingHost(filled as unknown as never)
      expect([selection.anchorOffset, selection.focusOffset]).toEqual([2, 4])
    })
  })

  describe("a parsed document", () => {
    it("is not the window's: its nodes are ignored by every method that names them", () => {
      const parsed = new DOMParser().parseFromString("<p>parsed</p>", "text/html")
      const paragraph = parsed.body.firstChild as unknown as Node
      const text = paragraph.firstChild as Node
      const own = tx("own")
      selection.collapse(n(own), 1)

      selection.collapse(text, 1)
      selection.setBaseAndExtent(text, 0, text, 2)
      selection.selectAllChildren(paragraph)
      selection.extend(text, 3)
      const range = new Range()
      range.selectNodeContents(paragraph)
      selection.removeAllRanges()
      selection.addRange(range)

      expect(selection.rangeCount).toBe(0)
      expect(selection.containsNode(text)).toBe(false)

      selection.collapse(n(own), 1)
      selection.collapse(text, 1)
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(own), 1])
    })
  })

  describe("modify", () => {
    function at(node: FakeTx, offset: number): void {
      selection.collapse(n(node), offset)
    }

    it("moves a caret by character over inline elements and by one step over a paragraph break", () => {
      const a = tx("ab")
      const b = tx("cd")
      const c = tx("ef")
      editable("div", el("p", a, el("b", b)), el("p", c))
      at(a, 1)
      selection.modify("move", "forward", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(a), 2])
      selection.modify("move", "forward", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(b), 1])
      selection.modify("move", "forward", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(b), 2])
      selection.modify("move", "forward", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(c), 0])
      selection.modify("move", "backward", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(b), 2])
      selection.modify("move", "left", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(b), 1])
    })

    it("stays at the edges of the editing host's text", () => {
      const a = tx("ab")
      const outside = tx("zz")
      const root = el("div", editable("div", a), el("p", outside))
      expect(root.kids).toHaveLength(2)
      at(a, 2)
      selection.modify("move", "forward", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(a), 2])
      at(a, 0)
      selection.modify("move", "backward", "character")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(a), 0])
    })

    it("moves by a grapheme cluster, not a code unit", () => {
      const a = tx("a\u{1F468}‍\u{1F469}b")
      editable("div", a)
      at(a, 1)
      selection.modify("move", "forward", "character")
      expect(selection.focusOffset).toBe(6)
      selection.modify("move", "backward", "character")
      expect(selection.focusOffset).toBe(1)
    })

    it("moves by word to the end of the next word, or the start of the previous", () => {
      const a = tx("hello big  world")
      editable("div", a)
      at(a, 0)
      selection.modify("move", "forward", "word")
      expect(selection.focusOffset).toBe(5)
      selection.modify("move", "forward", "word")
      expect(selection.focusOffset).toBe(9)
      selection.modify("move", "forward", "word")
      expect(selection.focusOffset).toBe(16)
      selection.modify("move", "backward", "word")
      expect(selection.focusOffset).toBe(11)
      selection.modify("move", "backward", "word")
      expect(selection.focusOffset).toBe(6)
    })

    it("collapses a range to its edge on a character move, and steps from the edge by word", () => {
      const a = tx("hello big world")
      editable("div", a)
      selection.setBaseAndExtent(n(a), 1, n(a), 3)
      selection.modify("move", "forward", "character")
      expect([selection.type, selection.focusOffset]).toEqual(["Caret", 3])
      selection.setBaseAndExtent(n(a), 1, n(a), 3)
      selection.modify("move", "backward", "character")
      expect([selection.type, selection.focusOffset]).toEqual(["Caret", 1])
      selection.setBaseAndExtent(n(a), 1, n(a), 3)
      selection.modify("move", "forward", "word")
      expect([selection.type, selection.focusOffset]).toEqual(["Caret", 5])
    })

    it("extend moves the focus and keeps the anchor", () => {
      const a = tx("hello big")
      editable("div", a)
      at(a, 2)
      selection.modify("extend", "forward", "character")
      selection.modify("extend", "forward", "word")
      expect([selection.anchorOffset, selection.focusOffset, selection.direction]).toEqual([2, 5, "forwards"])
      selection.modify("extend", "backward", "word")
      selection.modify("extend", "backward", "character")
      expect([selection.anchorOffset, selection.focusOffset, selection.direction]).toEqual([2, 0, "backwards"])
    })

    it("paragraph and sentence granularities throw NotSupportedError", () => {
      const a = tx("ab")
      editable("div", a)
      at(a, 1)
      for (const granularity of ["paragraph", "paragraphboundary", "sentence", "sentenceboundary"]) {
        expect(errorName(() => selection.modify("move", "forward", granularity))).toBe("NotSupportedError")
      }
      expect(selection.focusOffset).toBe(1)
    })

    it("an argument the standard does not name does nothing, and so does an empty selection", () => {
      const a = tx("ab")
      editable("div", a)
      at(a, 1)
      selection.modify("jump", "forward", "character")
      selection.modify("move", "up", "character")
      selection.modify("move", "forward", "page")
      expect(selection.focusOffset).toBe(1)
      selection.collapse(null)
      selection.modify("move", "forward", "character")
      expect(selection.rangeCount).toBe(0)
    })

    it("takes the keywords in any case", () => {
      const a = tx("abc")
      editable("div", a)
      at(a, 0)
      selection.modify("MOVE", "Forward", "Character")
      expect(selection.focusOffset).toBe(1)
    })
  })
})
