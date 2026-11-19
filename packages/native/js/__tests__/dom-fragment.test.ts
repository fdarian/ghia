import { describe, expect, it } from "vitest"
import {
  DOM_BINDING,
  DocumentFragment,
  HTMLElement,
  type Element,
  ShadowRoot,
  Text,
  type ElementBinding,
  type Node,
  type ParentBinding,
  type TextBinding,
} from "../dom/nodes.js"
import { hasLiveRanges, liveRangesAfterInsert, liveRangesBeforeRemove } from "../dom/live-ranges.js"
import { Range } from "../dom/range.js"
import { defineDomMembers } from "../dom-members.js"
import "../dom-globals.js"

/**
 * A tree kept the way an adapter keeps one: elements, text and fragments hold their children in a
 * mirror, and the live range hooks run where an adapter runs them. Each node is made through the
 * same factory, as an adapter makes the nodes of its window.
 */
type Kid = FakeEl | FakeTx
type Parent = FakeEl | FakeFrag

class FakeEl extends HTMLElement {
  parent: Parent | null = null
  readonly kids: Kid[] = []
  readonly props = new Map<string, string>()

  constructor(readonly type: string) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    return {
      ...parentBinding(this),
      parent: this.parent as Node | null,
      type: this.type,
      prop: (name) => this.props.get(name),
      propNames: () => this.props.keys(),
      setProp: (name, value) => {
        this.props.set(name, String(value))
      },
      style: {},
    }
  }
}

class FakeFrag extends DocumentFragment {
  readonly kids: Kid[]

  constructor() {
    super()
    this.kids = []
  }

  [DOM_BINDING](): ParentBinding {
    return { ...parentBinding(this), parent: null }
  }
}

class FakeTx extends Text {
  parent: Parent | null = null

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
      createFragment: () => new FakeFrag() as unknown as DocumentFragment,
    }
  }
}

function detach(node: Kid): void {
  const parent = node.parent
  if (parent === null) return
  const index = parent.kids.indexOf(node)
  if (hasLiveRanges()) liveRangesBeforeRemove(parent as unknown as Node, node as unknown as Node, index)
  parent.kids.splice(index, 1)
  node.parent = null
}

function parentBinding(owner: Parent): ParentBinding {
  return {
    parent: null,
    children: owner.kids as readonly Node[],
    connected: false,
    root: null,
    assertSameWindow() {},
    insertBefore(child, before) {
      const node = child as unknown as Kid
      detach(node)
      const index = before === null ? owner.kids.length : owner.kids.indexOf(before as unknown as Kid)
      owner.kids.splice(index, 0, node)
      node.parent = owner
      if (hasLiveRanges()) liveRangesAfterInsert(owner as unknown as Node, index, 1)
    },
    removeChild(child) {
      detach(child as unknown as Kid)
    },
    createText: (data) => new FakeTx(data) as unknown as Text,
    createElement: (type) => new FakeEl(type) as unknown as Element,
    createFragment: () => new FakeFrag() as unknown as DocumentFragment,
  }
}

defineDomMembers(FakeEl.prototype, () => ({
  listeners: undefined as never,
  connected: false,
  prop: () => undefined,
  layout: undefined,
}))

function el(type: string, ...children: Kid[]): FakeEl {
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

function frag(...children: Kid[]): FakeFrag {
  const fragment = new FakeFrag()
  for (const child of children) {
    child.parent = fragment
    fragment.kids.push(child)
  }
  return fragment
}

const n = (node: Kid | FakeFrag): Node => node as unknown as Node

/** A tree as `p[hello,b[bold]]`, text by its data. */
function shape(node: Kid | FakeFrag | Node): string {
  const kid = node as unknown as Kid | FakeFrag
  if (kid instanceof FakeTx) return JSON.stringify(kid.text).slice(1, -1)
  const inner = kid.kids.map(shape).join(",")
  return kid instanceof FakeFrag ? `#frag[${inner}]` : `${(kid as FakeEl).type}[${inner}]`
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

function rangeOver(startNode: Kid, startOffset: number, endNode: Kid, endOffset: number): Range {
  const range = new Range()
  range.setStart(n(startNode), startOffset)
  range.setEnd(n(endNode), endOffset)
  return range
}

describe("DocumentFragment", () => {
  it("is a node of type 11 that holds children", () => {
    const a = el("a")
    const fragment = frag(a, tx("x"))
    expect(fragment).toBeInstanceOf(DocumentFragment)
    expect(fragment.nodeType).toBe(11)
    expect(fragment.nodeName).toBe("#document-fragment")
    expect(fragment.parentNode).toBeNull()
    expect(fragment.firstChild).toBe(a)
    expect(fragment.childNodes).toHaveLength(2)
    expect(fragment.textContent).toBe("x")
    expect(fragment.children).toEqual([a])
    expect(fragment.childElementCount).toBe(1)
    expect(a.parentNode).toBe(fragment)
  })

  it("still cannot be constructed from code, and a ShadowRoot cannot be made at all", () => {
    expect(() => new (DocumentFragment as unknown as new () => unknown)()).toThrow(TypeError)
    class Shadow extends ShadowRoot {
      [DOM_BINDING](): ParentBinding {
        throw new Error("unused")
      }
    }
    expect(() => new Shadow()).toThrow(TypeError)
  })

  it("takes children through append, prepend, replaceChildren and textContent", () => {
    const fragment = new FakeFrag()
    fragment.append("a", n(el("b")), "c")
    fragment.prepend("z")
    expect(shape(fragment)).toBe("#frag[z,a,b[],c]")
    fragment.replaceChildren("only")
    expect(shape(fragment)).toBe("#frag[only]")
    fragment.textContent = "reset"
    expect(shape(fragment)).toBe("#frag[reset]")
    fragment.textContent = ""
    expect(shape(fragment)).toBe("#frag[]")
  })

  it("is cloned as a fragment, deeply or not", () => {
    const original = frag(el("p", tx("a")), tx("b"))
    const shallow = n(original).cloneNode(false) as unknown as FakeFrag
    expect(shallow).toBeInstanceOf(FakeFrag)
    expect(shallow).not.toBe(original)
    expect(shape(shallow)).toBe("#frag[]")
    expect(shape(n(original).cloneNode(true))).toBe("#frag[p[a],b]")
  })
})

describe("inserting a fragment", () => {
  it("appendChild moves its children in order and leaves it empty", () => {
    const a = el("a")
    const t = tx("t")
    const fragment = frag(a, t)
    const parent = el("div", tx("first"))
    expect(n(parent).appendChild(n(fragment))).toBe(n(fragment))
    expect(shape(parent)).toBe("div[first,a[],t]")
    expect(fragment.kids).toHaveLength(0)
    expect(a.parent).toBe(parent)
    expect(t.parent).toBe(parent)
  })

  it("insertBefore, replaceChild, before, after, replaceWith, append and prepend take a fragment", () => {
    const make = () => frag(el("x"), el("y"))
    const mid = el("m")
    const parent = el("div", el("l"), mid, el("r"))
    n(parent).insertBefore(n(make()), n(mid))
    expect(shape(parent)).toBe("div[l[],x[],y[],m[],r[]]")
    n(parent).replaceChild(n(make()), n(mid))
    expect(shape(parent)).toBe("div[l[],x[],y[],x[],y[],r[]]")
    const anchor = el("anchor")
    const second = el("div", anchor)
    n(anchor).before(n(make()))
    n(anchor).after(n(make()))
    expect(shape(second)).toBe("div[x[],y[],anchor[],x[],y[]]")
    n(anchor).replaceWith(n(make()))
    expect(shape(second)).toBe("div[x[],y[],x[],y[],x[],y[]]")
    const third = el("div", el("k"))
    n(third).append(n(make()))
    n(third).prepend(n(make()))
    expect(shape(third)).toBe("div[x[],y[],k[],x[],y[]]")
  })

  it("an empty fragment inserts nothing", () => {
    const parent = el("div", el("k"))
    n(parent).appendChild(n(frag()))
    expect(shape(parent)).toBe("div[k[]]")
  })

  it("a fragment can be filled and inserted again", () => {
    const fragment = new FakeFrag()
    n(fragment).appendChild(n(el("a")))
    n(el("div")).appendChild(n(fragment))
    n(fragment).appendChild(n(el("b")))
    const parent = el("div")
    n(parent).appendChild(n(fragment))
    expect(shape(parent)).toBe("div[b[]]")
  })

  it("moves a node out of the tree it was in, and a fragment can hold what an element held", () => {
    const a = el("a")
    const source = el("div", a, el("b"))
    const fragment = new FakeFrag()
    n(fragment).appendChild(n(a))
    expect(shape(source)).toBe("div[b[]]")
    expect(shape(fragment)).toBe("#frag[a[]]")
  })

  it("refuses a fragment into a node it holds, and into itself", () => {
    const inner = el("div")
    const fragment = frag(inner)
    expect(errorName(() => n(inner).appendChild(n(fragment)))).toBe("HierarchyRequestError")
    const second = frag()
    const holder = el("div")
    n(second).appendChild(n(holder))
    expect(errorName(() => n(holder).appendChild(n(second)))).toBe("HierarchyRequestError")
    expect(errorName(() => n(second).appendChild(n(second)))).toBe("HierarchyRequestError")
  })

  it("adjusts live ranges as the children leave the fragment and arrive", () => {
    const start = tx("ab")
    const parent = el("p", start, tx("cd"))
    const range = rangeOver(start, 1, parent.kids[1], 1)
    const fragment = frag(el("x"), el("y"))
    // Inserted between the two texts: the range's end moves with the second one, its start stays.
    n(parent).insertBefore(n(fragment), n(parent.kids[1]))
    expect(range.startContainer).toBe(n(start))
    expect(range.endContainer).toBe(n(parent.kids[3]))
    expect(range.toString()).toBe("b" + "c")

    const inside = frag(tx("q"), tx("r"))
    const insideRange = rangeOver(inside.kids[0], 0, inside.kids[1], 1)
    n(el("div")).appendChild(n(inside))
    // Each child leaves the fragment by an ordinary removal, which collapses a range inside it.
    expect(insideRange.collapsed).toBe(true)
    expect(insideRange.startContainer).toBe(n(inside))

    const boundary = el("p", tx("k"))
    const boundaryRange = new Range()
    boundaryRange.setStart(n(boundary), 1)
    boundaryRange.setEnd(n(boundary), 1)
    n(boundary).appendChild(n(frag(el("n"), el("o"))))
    // A boundary at the insertion point stays before the new nodes, as in the standard.
    expect(boundaryRange.startOffset).toBe(1)
    boundaryRange.setEnd(n(boundary), 3)
    n(boundary).insertBefore(n(frag(el("z"))), n(boundary.kids[1]))
    expect(boundaryRange.startOffset).toBe(1)
    expect(boundaryRange.endOffset).toBe(4)
  })
})

describe("Range.cloneContents", () => {
  it("returns an empty fragment for a collapsed range", () => {
    const text = tx("abc")
    const root = el("p", text)
    const fragment = rangeOver(text, 1, text, 1).cloneContents()
    expect(fragment).toBeInstanceOf(DocumentFragment)
    expect(shape(fragment)).toBe("#frag[]")
    expect(shape(root)).toBe("p[abc]")
  })

  it("copies the covered part of one text node", () => {
    const text = tx("abcdef")
    el("p", text)
    const fragment = rangeOver(text, 1, text, 4).cloneContents()
    expect(shape(fragment)).toBe("#frag[bcd]")
    expect(text.text).toBe("abcdef")
    expect((fragment as unknown as FakeFrag).kids[0]).not.toBe(text)
  })

  it("copies the ends of a range across two paragraphs and what is between", () => {
    const a = tx("first")
    const b = tx("second")
    const mid = el("hr")
    const root = el("div", el("p", a), mid, el("p", b))
    const range = rangeOver(a, 2, b, 3)
    const fragment = range.cloneContents()
    expect(shape(fragment)).toBe("#frag[p[rst],hr[],p[sec]]")
    expect(shape(root)).toBe("div[p[first],hr[],p[second]]")
    expect(range.startContainer).toBe(n(a))
    expect(range.endOffset).toBe(3)
    const copies = (fragment as unknown as FakeFrag).kids
    expect(copies[1]).not.toBe(mid)
  })

  it("copies an element a boundary is inside as a shallow copy holding the covered children", () => {
    const text = tx("bold")
    const root = el("div", tx("pre"), el("b", text, tx("tail")), tx("post"))
    root.kids[1].props.set("id", "x")
    const fragment = rangeOver(root.kids[0] as FakeTx, 1, text, 2).cloneContents()
    expect(shape(fragment)).toBe("#frag[re,b[bo]]")
    expect(((fragment as unknown as FakeFrag).kids[1] as FakeEl).props.get("id")).toBe("x")
  })

  it("copies a range between element boundaries as whole nodes", () => {
    const root = el("ul", el("li", tx("a")), el("li", tx("b")), el("li", tx("c")))
    const range = new Range()
    range.setStart(n(root), 1)
    range.setEnd(n(root), 3)
    expect(shape(range.cloneContents())).toBe("#frag[li[b],li[c]]")
    expect(shape(root)).toBe("ul[li[a],li[b],li[c]]")
  })
})

describe("Range.extractContents", () => {
  it("returns an empty fragment for a collapsed range", () => {
    const text = tx("abc")
    el("p", text)
    expect(shape(rangeOver(text, 1, text, 1).extractContents())).toBe("#frag[]")
  })

  it("cuts the covered part of one text node and collapses the range", () => {
    const text = tx("abcdef")
    const root = el("p", text)
    const range = rangeOver(text, 1, text, 4)
    const fragment = range.extractContents()
    expect(shape(fragment)).toBe("#frag[bcd]")
    expect(shape(root)).toBe("p[aef]")
    expect(range.collapsed).toBe(true)
    expect(range.startContainer).toBe(n(text))
    expect(range.startOffset).toBe(1)
  })

  it("moves two paragraphs' covered parts, splits the ends and collapses after the first paragraph", () => {
    const a = tx("first")
    const b = tx("second")
    const mid = el("hr")
    const p1 = el("p", a)
    const p2 = el("p", b)
    const root = el("div", p1, mid, p2)
    const range = rangeOver(a, 2, b, 3)
    const fragment = range.extractContents()
    expect(shape(fragment)).toBe("#frag[p[rst],hr[],p[sec]]")
    expect(shape(root)).toBe("div[p[fi],p[ond]]")
    // The nodes between moved, the ends were copied.
    expect((fragment as unknown as FakeFrag).kids[1]).toBe(mid)
    expect(p1.parent).toBe(root)
    expect(range.collapsed).toBe(true)
    expect(range.startContainer).toBe(n(root))
    expect(range.startOffset).toBe(1)
  })

  it("moves whole nodes between element boundaries", () => {
    const items = [el("li", tx("a")), el("li", tx("b")), el("li", tx("c"))]
    const root = el("ul", ...items)
    const range = new Range()
    range.setStart(n(root), 1)
    range.setEnd(n(root), 3)
    const fragment = range.extractContents()
    expect(shape(fragment)).toBe("#frag[li[b],li[c]]")
    expect((fragment as unknown as FakeFrag).kids[0]).toBe(items[1])
    expect(shape(root)).toBe("ul[li[a]]")
    expect(range.startContainer).toBe(n(root))
    expect(range.startOffset).toBe(1)
    expect(range.collapsed).toBe(true)
  })

  it("extracts through a nested boundary and leaves the emptied ends in place", () => {
    const deep = tx("deepest")
    const root = el("div", tx("x"), el("section", el("p", deep), tx("after")), tx("y"))
    const range = rangeOver(deep, 4, deep, 4)
    range.setEnd(n(root), 2)
    const fragment = range.extractContents()
    expect(shape(fragment)).toBe("#frag[section[p[est],after]]")
    expect(shape(root)).toBe("div[x,section[p[deep]],y]")
  })

  it("moves other live ranges as an ordinary removal does", () => {
    const text = tx("abcdef")
    const root = el("p", text)
    const other = rangeOver(text, 5, text, 6)
    rangeOver(text, 1, text, 4).extractContents()
    expect(text.text).toBe("aef")
    expect(other.startOffset).toBe(2)
    expect(other.endOffset).toBe(3)
    expect(root.kids).toHaveLength(1)
  })
})

describe("Range.surroundContents", () => {
  it("wraps a range inside one text node", () => {
    const text = tx("abcdef")
    const root = el("p", text)
    const wrapper = el("b")
    const range = rangeOver(text, 1, text, 4)
    range.surroundContents(n(wrapper))
    expect(shape(root)).toBe("p[a,b[bcd],ef]")
    expect(range.startContainer).toBe(n(root))
    expect(range.startOffset).toBe(1)
    expect(range.endOffset).toBe(2)
  })

  it("empties the new parent first", () => {
    const text = tx("abc")
    const root = el("p", text)
    const wrapper = el("i", tx("old"))
    rangeOver(text, 0, text, 3).surroundContents(n(wrapper))
    // The standard leaves the empty halves of the split text where they are.
    expect(shape(root)).toBe("p[,i[abc],]")
  })

  it("throws InvalidStateError for a range that cuts an element, and InvalidNodeTypeError for a fragment", () => {
    const a = tx("one")
    const b = tx("two")
    const root = el("div", el("p", a), el("p", b))
    const across = rangeOver(a, 1, b, 1)
    expect(errorName(() => across.surroundContents(n(el("b"))))).toBe("InvalidStateError")
    expect(shape(root)).toBe("div[p[one],p[two]]")
    const text = tx("abc")
    el("p", text)
    expect(errorName(() => rangeOver(text, 0, text, 1).surroundContents(n(frag())))).toBe("InvalidNodeTypeError")
  })
})

describe("Range.insertNode with a fragment", () => {
  it("inserts the children at an element boundary and extends a collapsed range over them", () => {
    const root = el("p", el("a"), el("c"))
    const range = new Range()
    range.setStart(n(root), 1)
    range.setEnd(n(root), 1)
    range.insertNode(n(frag(el("b1"), el("b2"))))
    expect(shape(root)).toBe("p[a[],b1[],b2[],c[]]")
    expect(range.startOffset).toBe(1)
    expect(range.endOffset).toBe(3)
  })

  it("splits a text start and puts the children between the halves", () => {
    const text = tx("abcd")
    const root = el("p", text)
    const range = rangeOver(text, 2, text, 2)
    range.insertNode(n(frag(el("x"), tx("y"))))
    expect(shape(root)).toBe("p[ab,x[],y,cd]")
    expect(range.startContainer).toBe(n(text))
    expect(range.startOffset).toBe(2)
    expect(range.endContainer).toBe(n(root))
    expect(range.endOffset).toBe(3)
  })

  it("inserts an empty fragment as nothing and still splits the text", () => {
    const text = tx("abcd")
    const root = el("p", text)
    const range = rangeOver(text, 2, text, 2)
    range.insertNode(n(frag()))
    expect(shape(root)).toBe("p[ab,cd]")
    expect(range.collapsed).toBe(false)
  })

  it("round-trips: what extractContents takes insertNode puts back", () => {
    const text = tx("abcdef")
    const root = el("p", text)
    const taken = rangeOver(text, 2, text, 4).extractContents()
    expect(shape(root)).toBe("p[abef]")
    const put = rangeOver(text, 2, text, 2)
    put.insertNode(taken as unknown as Node)
    expect(shape(root)).toBe("p[ab,cd,ef]")
  })
})
