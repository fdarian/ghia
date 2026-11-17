import { describe, expect, it } from "vitest"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { hasLiveRanges, liveRangesAfterInsert, liveRangesBeforeRemove } from "../dom/live-ranges.js"
import { boundariesOf, createTextFor, Range, StaticRange } from "../dom/range.js"
import { document } from "../events/window-target.js"
import { defineDomMembers } from "../dom-members.js"
import "../dom-globals.js"

/**
 * A tree kept the way an adapter keeps one: the two primitives of the DOM members, with the live
 * range hooks called where an adapter calls them (before a child leaves, after one is placed).
 */
class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeTx> = []

  constructor(readonly type: string) {
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
      connected: false,
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
    connected: false,
    root: null,
    type: element.type,
    prop: () => undefined,
    propNames: () => [],
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

defineDomMembers(FakeEl.prototype, () => ({
  listeners: undefined as never,
  connected: false,
  prop: () => undefined,
  layout: undefined,
}))

function el(type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = new FakeEl(type)
  for (const child of children) {
    child.parent = element
    element.kids.push(child)
  }
  return element
}

function tx(text: string): FakeTx {
  return new FakeTx(text)
}

const n = (node: FakeEl | FakeTx): Node => node as unknown as Node

/** The range as `container:offset-container:offset`, where a node is named by `names`. */
function describeRange(range: Range, names: Map<unknown, string>): string {
  return `${names.get(range.startContainer)}:${range.startOffset}-${names.get(range.endContainer)}:${range.endOffset}`
}

function errorName(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof DOMException) return error.name
    throw error
  }
  return "no error"
}

function expectKids(parent: FakeEl, ...expected: Array<FakeEl | FakeTx>): void {
  expect(parent.kids.length).toBe(expected.length)
  expected.forEach((node, index) => expect(parent.kids[index]).toBe(node))
}

function rangeOver(startNode: FakeEl | FakeTx, startOffset: number, endNode: FakeEl | FakeTx, endOffset: number): Range {
  const range = new Range()
  range.setStart(n(startNode), startOffset)
  range.setEnd(n(endNode), endOffset)
  return range
}

describe("Range construction", () => {
  it("starts collapsed at the start of the document, from the constructor and createRange", () => {
    for (const range of [new Range(), document.createRange()]) {
      expect(range.startContainer).toBe(document)
      expect(range.endContainer).toBe(document)
      expect(range.startOffset).toBe(0)
      expect(range.endOffset).toBe(0)
      expect(range.collapsed).toBe(true)
      expect(range.commonAncestorContainer).toBe(document)
    }
  })

  it("is a Range and an AbstractRange, and AbstractRange has no constructor", () => {
    expect(new Range()).toBeInstanceOf(Range)
    expect(new Range()).toBeInstanceOf((globalThis as unknown as { AbstractRange: Function }).AbstractRange)
    expect(globalThis.Range).toBe(Range)
    expect(globalThis.StaticRange).toBe(StaticRange)
    expect(() => new (globalThis as unknown as { AbstractRange: new () => unknown }).AbstractRange()).toThrow(TypeError)
  })

  it("has the comparison constants on the class and its instances", () => {
    expect([Range.START_TO_START, Range.START_TO_END, Range.END_TO_END, Range.END_TO_START]).toEqual([0, 1, 2, 3])
    expect(new Range().END_TO_START).toBe(3)
  })
})

describe("StaticRange", () => {
  it("keeps what it is given, without checking it against the tree", () => {
    const text = tx("abc")
    const range = new StaticRange({ startContainer: n(text), startOffset: 9, endContainer: n(text), endOffset: 1 })
    expect(range.startContainer).toBe(n(text))
    expect(range.startOffset).toBe(9)
    expect(range.endOffset).toBe(1)
    expect(range.collapsed).toBe(false)
  })

  it("is not live", () => {
    const text = tx("abc")
    const parent = el("p", text)
    const range = new StaticRange({ startContainer: n(text), startOffset: 2, endContainer: n(text), endOffset: 3 })
    n(text).deleteData(0, 2)
    expect(range.startOffset).toBe(2)
    expect(parent.kids).toHaveLength(1)
  })

  it("throws a TypeError for a missing member", () => {
    const text = tx("abc")
    expect(() => new StaticRange({ startContainer: n(text), startOffset: 0, endContainer: n(text) } as never)).toThrow(TypeError)
    expect(() => new StaticRange({ startOffset: 0, endContainer: n(text), endOffset: 0 } as never)).toThrow(TypeError)
    expect(() => new StaticRange(undefined as never)).toThrow(TypeError)
  })
})

describe("Range boundary points", () => {
  it("setStart and setEnd check the offset, and keep start before end", () => {
    const text = tx("hello")
    const root = el("div", text)
    const range = new Range()
    range.setStart(n(text), 2)
    // The start moved past the old end, in another tree, so the end follows it.
    expect(range.collapsed).toBe(true)
    expect(range.endContainer).toBe(n(text))
    range.setEnd(n(text), 4)
    expect(range.toString()).toBe("ll")
    range.setStart(n(text), 5)
    expect(describeRange(range, new Map([[n(text), "t"]]))).toBe("t:5-t:5")
    expect(errorName(() => range.setStart(n(text), 6))).toBe("IndexSizeError")
    expect(errorName(() => range.setEnd(n(root), 2))).toBe("IndexSizeError")
    expect(() => range.setStart(null as never, 0)).toThrow(TypeError)
  })

  it("collapses the other end when a point is set in another tree", () => {
    const first = tx("a")
    const second = tx("b")
    el("p", first)
    el("p", second)
    const range = rangeOver(first, 0, first, 1)
    range.setEnd(n(second), 1)
    expect(range.startContainer).toBe(n(second))
    expect(range.collapsed).toBe(true)
  })

  it("setStartBefore, setStartAfter, setEndBefore and setEndAfter use the parent and the index", () => {
    const a = el("a")
    const b = el("b")
    const c = el("c")
    const root = el("div", a, b, c)
    const range = new Range()
    range.setStartBefore(n(b))
    range.setEndAfter(n(b))
    expect(range.startContainer).toBe(n(root))
    expect([range.startOffset, range.endOffset]).toEqual([1, 2])
    range.setEndBefore(n(c))
    range.setStartAfter(n(a))
    expect([range.startOffset, range.endOffset]).toEqual([1, 2])
    expect(errorName(() => range.setStartBefore(n(root)))).toBe("InvalidNodeTypeError")
  })

  it("selectNode and selectNodeContents", () => {
    const text = tx("abc")
    const b = el("b")
    const root = el("div", b, text)
    const range = new Range()
    range.selectNode(n(text))
    expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([n(root), 1, n(root), 2])
    range.selectNodeContents(n(text))
    expect([range.startContainer, range.startOffset, range.endOffset]).toEqual([n(text), 0, 3])
    range.selectNodeContents(n(root))
    expect([range.startOffset, range.endOffset]).toEqual([0, 2])
    expect(errorName(() => range.selectNode(n(root)))).toBe("InvalidNodeTypeError")
  })

  it("collapse goes to either end", () => {
    const text = tx("abcd")
    el("p", text)
    const range = rangeOver(text, 1, text, 3)
    range.collapse(true)
    expect([range.startOffset, range.endOffset]).toEqual([1, 1])
    range.setEnd(n(text), 3)
    range.collapse()
    expect([range.startOffset, range.endOffset]).toEqual([3, 3])
  })

  it("cloneRange is a separate range with the same boundary points", () => {
    const text = tx("abcd")
    el("p", text)
    const range = rangeOver(text, 1, text, 3)
    const clone = range.cloneRange()
    expect(clone).not.toBe(range)
    range.collapse(true)
    expect([clone.startOffset, clone.endOffset]).toEqual([1, 3])
    clone.detach()
    expect(clone.endOffset).toBe(3)
  })

  it("commonAncestorContainer is the deepest node holding both ends", () => {
    const a = tx("a")
    const b = tx("b")
    const inner = el("i", a)
    const root = el("div", inner, b)
    expect(rangeOver(a, 0, b, 1).commonAncestorContainer).toBe(n(root))
    expect(rangeOver(a, 0, a, 1).commonAncestorContainer).toBe(n(a))
    expect(rangeOver(inner, 0, inner, 1).commonAncestorContainer).toBe(n(inner))
  })
})

describe("Range comparisons", () => {
  const a = tx("abcdef")
  const b = tx("ghij")
  const root = el("div", a, el("i", b))

  it("compareBoundaryPoints answers for each of the four methods", () => {
    const outer = rangeOver(a, 1, b, 2)
    const inner = rangeOver(a, 3, a, 5)
    expect(outer.compareBoundaryPoints(Range.START_TO_START, inner)).toBe(-1)
    expect(outer.compareBoundaryPoints(Range.END_TO_END, inner)).toBe(1)
    expect(outer.compareBoundaryPoints(Range.START_TO_END, inner)).toBe(1)
    expect(outer.compareBoundaryPoints(Range.END_TO_START, inner)).toBe(-1)
    expect(inner.compareBoundaryPoints(Range.START_TO_END, outer)).toBe(1)
    expect(inner.compareBoundaryPoints(Range.END_TO_START, outer)).toBe(-1)
    expect(inner.compareBoundaryPoints(Range.START_TO_START, inner.cloneRange())).toBe(0)
  })

  it("compareBoundaryPoints throws for another tree and for an unknown method", () => {
    const other = tx("z")
    el("p", other)
    const range = rangeOver(a, 0, a, 1)
    expect(errorName(() => range.compareBoundaryPoints(0, rangeOver(other, 0, other, 1)))).toBe("WrongDocumentError")
    expect(errorName(() => range.compareBoundaryPoints(4, range))).toBe("NotSupportedError")
  })

  it("compares a point in an ancestor with one in a descendant by child index", () => {
    const range = rangeOver(a, 0, b, 4)
    expect(range.comparePoint(n(root), 0)).toBe(-1)
    expect(range.comparePoint(n(root), 1)).toBe(0)
    expect(range.comparePoint(n(root), 2)).toBe(1)
    expect(range.comparePoint(n(a), 0)).toBe(0)
    expect(range.comparePoint(n(b), 4)).toBe(0)
  })

  it("comparePoint and isPointInRange throw IndexSizeError past the length", () => {
    const range = rangeOver(a, 0, a, 2)
    expect(errorName(() => range.comparePoint(n(a), 7))).toBe("IndexSizeError")
    expect(errorName(() => range.isPointInRange(n(a), 7))).toBe("IndexSizeError")
  })

  it("comparePoint throws for another tree, isPointInRange answers false", () => {
    const other = tx("z")
    el("p", other)
    const range = rangeOver(a, 0, a, 2)
    expect(errorName(() => range.comparePoint(n(other), 0))).toBe("WrongDocumentError")
    expect(range.isPointInRange(n(other), 0)).toBe(false)
  })

  it("isPointInRange includes both boundary points", () => {
    const range = rangeOver(a, 2, a, 4)
    expect([1, 2, 3, 4, 5].map((offset) => range.isPointInRange(n(a), offset))).toEqual([false, true, true, true, false])
  })

  it("intersectsNode is true for a node the range touches, and for a node with no parent", () => {
    const first = el("a")
    const second = el("b")
    const third = el("c")
    const parent = el("div", first, second, third)
    const range = new Range()
    range.setStart(n(parent), 1)
    range.setEnd(n(parent), 2)
    expect([first, second, third].map((node) => range.intersectsNode(n(node)))).toEqual([false, true, false])
    expect(range.intersectsNode(n(parent))).toBe(true)
    expect(range.intersectsNode(n(el("loose")))).toBe(false)
  })

  it("toString joins the text the range covers", () => {
    const first = tx("abc")
    const middle = tx("DEF")
    const last = tx("ghi")
    const inner = el("i", middle)
    el("div", first, inner, last)
    expect(rangeOver(first, 1, last, 2).toString()).toBe("bcDEFgh")
    expect(rangeOver(first, 1, first, 3).toString()).toBe("bc")
    expect(rangeOver(first, 3, last, 0).toString()).toBe("DEF")
    expect(new Range().toString()).toBe("")
  })
})

describe("Range live adjustment on child changes", () => {
  function sample() {
    const a = el("a")
    const b = el("b", tx("inner"))
    const c = el("c")
    const root = el("div", a, b, c)
    const names = new Map<unknown, string>([
      [n(root), "root"],
      [n(a), "a"],
      [n(b), "b"],
      [n(c), "c"],
      [n(b.kids[0]), "inner"],
    ])
    return { a, b, c, root, names }
  }

  it("moves an end back to the parent at the index of a removed node holding it", () => {
    const { b, root, names } = sample()
    const range = rangeOver(b.kids[0], 2, b.kids[0], 4)
    n(root).removeChild(n(b))
    expect(describeRange(range, names)).toBe("root:1-root:1")
  })

  it("lowers an offset in the parent that lies after a removed child, and keeps one before it", () => {
    const { a, root, names } = sample()
    const range = rangeOver(root, 1, root, 3)
    n(root).removeChild(n(a))
    expect(describeRange(range, names)).toBe("root:0-root:2")
    const other = rangeOver(root, 0, root, 1)
    n(root).removeChild(n(root.kids[1]))
    expect(describeRange(other, names)).toBe("root:0-root:1")
  })

  it("raises an offset after an insert before it, and not one at the insert point's start", () => {
    const { a, root, names } = sample()
    const range = rangeOver(root, 0, root, 2)
    n(root).insertBefore(n(el("x")), n(root.kids[1]))
    expect(describeRange(range, names)).toBe("root:0-root:3")
    n(root).insertBefore(n(el("y")), n(a))
    expect(describeRange(range, names)).toBe("root:0-root:4")
    n(root).appendChild(n(el("z")))
    expect(describeRange(range, names)).toBe("root:0-root:4")
  })

  it("follows a node that is moved: its removal collapses a range inside it", () => {
    const { b, c, root, names } = sample()
    const range = rangeOver(b.kids[0], 1, b.kids[0], 3)
    n(c).appendChild(n(b))
    expect(describeRange(range, names)).toBe("root:1-root:1")
    expect(root.kids).toHaveLength(2)
  })

  it("adjusts every range", () => {
    const { a, root, names } = sample()
    const first = rangeOver(root, 1, root, 2)
    const second = rangeOver(root, 2, root, 3)
    n(root).removeChild(n(a))
    expect([describeRange(first, names), describeRange(second, names)]).toEqual(["root:0-root:1", "root:1-root:2"])
    expect(hasLiveRanges()).toBe(true)
  })
})

describe("Range live adjustment on text changes", () => {
  function inText(startOffset: number, endOffset: number) {
    const text = tx("0123456789")
    const parent = el("p", text)
    return { text, parent, range: rangeOver(text, startOffset, text, endOffset) }
  }

  it("deleteData pulls boundary points inside the deleted part to its start and shifts later ones", () => {
    const { text, range } = inText(3, 8)
    n(text).deleteData(2, 4)
    expect([range.startOffset, range.endOffset]).toEqual([2, 4])
    expect(text.text).toBe("016789")
  })

  it("insertData and appendData shift only the points after the offset", () => {
    const { text, range } = inText(3, 8)
    n(text).insertData(3, "ab")
    expect([range.startOffset, range.endOffset]).toEqual([3, 10])
    n(text).insertData(0, "x")
    expect([range.startOffset, range.endOffset]).toEqual([4, 11])
    n(text).appendData("yz")
    expect([range.startOffset, range.endOffset]).toEqual([4, 11])
    expect(text.text).toBe("x012ab3456789yz")
  })

  it("replaceData moves a point inside the replaced part to its start, after it by the difference", () => {
    const { text, range } = inText(3, 8)
    n(text).replaceData(2, 3, "ABCDE")
    expect([range.startOffset, range.endOffset]).toEqual([2, 10])
    n(text).replaceData(0, 6, "")
    expect([range.startOffset, range.endOffset]).toEqual([0, 4])
    expect(text.text).toBe("E56789")
  })

  it("the data setter, nodeValue and textContent collapse a range inside the text to 0", () => {
    for (const write of [
      (text: Text) => (text.data = "new"),
      (text: Text) => (text.nodeValue = "new"),
      (text: Text) => (text.textContent = "new"),
    ]) {
      const { text, range } = inText(3, 8)
      write(n(text) as Text)
      expect([range.startOffset, range.endOffset]).toEqual([0, 0])
      expect(text.text).toBe("new")
    }
  })

  it("a range in another node of the same parent is left alone", () => {
    const text = tx("abcd")
    const other = tx("wxyz")
    el("p", text, other)
    const range = rangeOver(other, 1, other, 3)
    n(text).deleteData(0, 4)
    expect([range.startOffset, range.endOffset]).toEqual([1, 3])
  })
})

describe("CharacterData and Text members", () => {
  it("substringData clamps the count and checks the offset", () => {
    const text = tx("hello")
    expect(n(text).substringData(1, 2)).toBe("el")
    expect(n(text).substringData(3, 99)).toBe("lo")
    expect(n(text).substringData(5, 1)).toBe("")
    expect(errorName(() => n(text).substringData(6, 1))).toBe("IndexSizeError")
  })

  it("insertData, deleteData and replaceData check the offset, and clamp a count that is too long", () => {
    const text = tx("hello")
    expect(errorName(() => n(text).insertData(6, "x"))).toBe("IndexSizeError")
    expect(errorName(() => n(text).deleteData(6, 1))).toBe("IndexSizeError")
    expect(errorName(() => n(text).replaceData(9, 0, ""))).toBe("IndexSizeError")
    n(text).deleteData(3, 100)
    expect(text.text).toBe("hel")
    n(text).replaceData(1, 99, "ipp")
    expect(text.text).toBe("hipp")
    n(text).insertData(4, "!")
    expect(text.text).toBe("hipp!")
    expect(n(text).length).toBe(5)
  })

  it("splitText keeps the front, makes the rest a following sibling, and checks the offset", () => {
    const text = tx("hello")
    const parent = el("p", text, el("b"))
    const rest = n(text).splitText(2)
    expect(text.text).toBe("he")
    expect(rest.data).toBe("llo")
    expect(parent.kids[1]).toBe(rest)
    expect(parent.kids).toHaveLength(3)
    expect(errorName(() => n(text).splitText(3))).toBe("IndexSizeError")
    expect(n(rest).splitText(3).data).toBe("")
  })

  it("splitText on a node with no parent makes a node in no tree", () => {
    const text = tx("hello")
    const rest = n(text).splitText(1)
    expect(text.text).toBe("h")
    expect(rest.data).toBe("ello")
    expect(rest.parentNode).toBe(null)
  })

  it("wholeText joins the text nodes next to each other", () => {
    const first = tx("a")
    const second = tx("b")
    const third = tx("c")
    const parent = el("p", first, second, el("i"), third)
    expect(n(second).wholeText).toBe("ab")
    expect(n(first).wholeText).toBe("ab")
    expect(n(third).wholeText).toBe("c")
    expect(parent.kids).toHaveLength(4)
  })
})

describe("Text.splitText and live ranges", () => {
  function split() {
    const text = tx("0123456789")
    const sibling = el("b")
    const root = el("div", text, sibling)
    const names = new Map<unknown, string>([[n(text), "t"], [n(root), "root"]])
    return { text, root, names }
  }

  it("moves a boundary point after the split offset into the new node", () => {
    const { text, root, names } = split()
    const range = rangeOver(text, 3, text, 8)
    const rest = n(text).splitText(5)
    names.set(rest, "rest")
    expect(describeRange(range, names)).toBe("t:3-rest:3")
    expect(root.kids[1]).toBe(rest)
  })

  it("keeps a point at the split offset in the first node", () => {
    const { text, names } = split()
    const range = rangeOver(text, 5, text, 5)
    const rest = n(text).splitText(5)
    names.set(rest, "rest")
    expect(describeRange(range, names)).toBe("t:5-t:5")
  })

  it("moves a point after the text node in the parent up by one, for the inserted node", () => {
    const { text, root, names } = split()
    const atNode = rangeOver(root, 1, root, 2)
    const before = rangeOver(root, 0, root, 1)
    n(text).splitText(4)
    expect(describeRange(atNode, names)).toBe("root:2-root:3")
    expect(describeRange(before, names)).toBe("root:0-root:2")
  })

  it("with no parent, collapses the points in the cut-off part to the split offset", () => {
    const text = tx("0123456789")
    const range = rangeOver(text, 6, text, 9)
    n(text).splitText(4)
    expect([range.startOffset, range.endOffset]).toEqual([4, 4])
  })
})

describe("Range.deleteContents", () => {
  it("does nothing for a collapsed range", () => {
    const text = tx("abc")
    el("p", text)
    rangeOver(text, 1, text, 1).deleteContents()
    expect(text.text).toBe("abc")
  })

  it("cuts the data within one text node", () => {
    const text = tx("abcdef")
    el("p", text)
    const range = rangeOver(text, 1, text, 4)
    range.deleteContents()
    expect(text.text).toBe("aef")
    expect([range.startOffset, range.endOffset, range.collapsed]).toEqual([1, 1, true])
  })

  it("removes the nodes between, and cuts the two end texts", () => {
    const first = tx("abcd")
    const middle = el("i", tx("mid"))
    const last = tx("wxyz")
    const root = el("div", first, middle, last)
    const range = rangeOver(first, 2, last, 2)
    range.deleteContents()
    expect(first.text).toBe("ab")
    expect(last.text).toBe("yz")
    expectKids(root, first, last)
    // The range collapses after the start node, in the common ancestor.
    expect([range.startContainer, range.startOffset]).toEqual([n(root), 1])
    expect(range.collapsed).toBe(true)
  })

  it("collapses at the start when the start node holds the end", () => {
    const a = el("a")
    const b = el("b")
    const c = el("c")
    const root = el("div", a, b, c)
    const range = rangeOver(root, 1, root, 3)
    range.deleteContents()
    expectKids(root, a)
    expect([range.startContainer, range.startOffset, range.endOffset]).toEqual([n(root), 1, 1])
  })

  it("moves another live range with the removal", () => {
    const a = el("a")
    const b = el("b", tx("x"))
    const c = el("c")
    const root = el("div", a, b, c)
    const watcher = rangeOver(b.kids[0], 0, b.kids[0], 1)
    rangeOver(root, 1, root, 2).deleteContents()
    expect([watcher.startContainer, watcher.startOffset, watcher.endOffset]).toEqual([n(root), 1, 1])
  })
})

describe("Range.insertNode", () => {
  it("inserts at the child the start offset names, and wraps it when the range is collapsed", () => {
    const a = el("a")
    const b = el("b")
    const root = el("div", a, b)
    const range = rangeOver(root, 1, root, 1)
    const inserted = el("x")
    range.insertNode(n(inserted))
    expectKids(root, a, inserted, b)
    expect([range.startOffset, range.endContainer, range.endOffset]).toEqual([1, n(root), 2])
  })

  it("appends when the start is at the end of the parent", () => {
    const a = el("a")
    const root = el("div", a)
    const range = rangeOver(root, 1, root, 1)
    const inserted = el("x")
    range.insertNode(n(inserted))
    expectKids(root, a, inserted)
    expect(range.endOffset).toBe(2)
  })

  it("splits a text start, and places the node between the halves", () => {
    const text = tx("abcd")
    const root = el("div", text)
    const range = rangeOver(text, 2, text, 3)
    const inserted = el("x")
    range.insertNode(n(inserted))
    expect(text.text).toBe("ab")
    expect(root.kids).toHaveLength(3)
    expect(root.kids[1]).toBe(inserted)
    expect((root.kids[2] as FakeTx).text).toBe("cd")
    // The range was not collapsed, so its end moved with the split into the second half.
    expect([range.startContainer, range.startOffset]).toEqual([n(text), 2])
    expect([range.endContainer, range.endOffset]).toEqual([n(root.kids[2]), 1])
  })

  it("throws for a start that cannot take the node, and for a node that cannot go there", () => {
    const loose = tx("abc")
    expect(errorName(() => rangeOver(loose, 1, loose, 1).insertNode(n(el("x"))))).toBe("HierarchyRequestError")
    const root = el("div")
    const inner = el("p")
    root.kids.push(inner)
    inner.parent = root
    expect(errorName(() => rangeOver(inner, 0, inner, 0).insertNode(n(root)))).toBe("HierarchyRequestError")
  })

  it("moves a node that is in the tree", () => {
    const a = el("a")
    const b = el("b")
    const c = el("c")
    const root = el("div", a, b, c)
    const range = rangeOver(root, 1, root, 1)
    range.insertNode(n(c))
    expectKids(root, a, c, b)
  })
})

describe("a range that has an owner", () => {
  function owned(range: Range): { calls: number } {
    const log = { calls: 0 }
    boundariesOf(range).onAdjust = () => {
      log.calls += 1
    }
    return log
  }

  it("tells it of each change its own methods make, and of none that change nothing", () => {
    const a = tx("hello")
    const b = tx("world")
    el("div", a, b)
    const range = rangeOver(a, 1, a, 3)
    const log = owned(range)
    range.setStart(n(a), 0)
    range.setEnd(n(b), 2)
    range.collapse(true)
    range.selectNode(n(b))
    range.selectNodeContents(n(a))
    range.setStartAfter(n(a))
    range.setEndAfter(n(b))
    expect(log.calls).toBe(7)
    range.setEndAfter(n(b))
    range.setStartAfter(n(a))
    expect(log.calls).toBe(7)
  })

  it("is told when deleteContents and insertNode change it", () => {
    const a = tx("hello")
    const b = tx("world")
    el("div", a, b)
    const range = rangeOver(a, 1, b, 2)
    const log = owned(range)
    range.deleteContents()
    expect(log.calls).toBeGreaterThan(0)
    expect([a.text, b.text]).toEqual(["h", "rld"])
    const before = log.calls
    range.deleteContents()
    expect(log.calls).toBe(before)
    range.insertNode(n(el("i")))
    expect(log.calls).toBeGreaterThan(before)
  })

  it("is told of a tree change too, and nothing once the owner lets go", () => {
    const a = tx("hello")
    const root = el("div", a)
    const range = rangeOver(a, 2, a, 4)
    const log = owned(range)
    n(a).insertData(0, "xx")
    expect(log.calls).toBe(1)
    boundariesOf(range).onAdjust = undefined
    n(root).removeChild(n(a))
    expect(log.calls).toBe(1)
    expect(range.startContainer).toBe(n(root))
  })
})

describe("createTextFor", () => {
  it("makes the Text through the binding of the node it is for", () => {
    const parent = el("p", tx("a"))
    const made = createTextFor(n(parent), "xyz")
    expect(made).toBeInstanceOf(FakeTx)
    expect(made.data).toBe("xyz")
    expect(made.parentNode).toBeNull()
  })
})
