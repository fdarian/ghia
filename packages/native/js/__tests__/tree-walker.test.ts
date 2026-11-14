import { describe, expect, it } from "vitest"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { document } from "../events/window-target.js"
import "../dom-globals.js"

class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeTx> = []

  constructor(readonly type: string) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    return {
      parent: this.parent as Node | null,
      children: this.kids as readonly Node[],
      connected: false,
      root: null,
      type: this.type,
    } as unknown as ElementBinding
  }
}

class FakeTx extends Text {
  parent: FakeEl | null = null

  constructor(readonly text: string) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    return { parent: this.parent as Node | null, children: [], connected: false, root: null, data: this.text } as unknown as TextBinding
  }
}

function el(type: string, ...children: Array<FakeEl | FakeTx>): FakeEl {
  const element = new FakeEl(type)
  for (const child of children) {
    child.parent = element
    element.kids.push(child)
  }
  return element
}

const tx = (text: string) => new FakeTx(text)

function name(node: Node | null): string | null {
  if (node === null) return null
  return node instanceof FakeEl ? node.type : `"${(node as unknown as FakeTx).text}"`
}

/**
 * <div>
 *   <p>"a"<b>"b"</b></p>
 *   <i/>
 *   "c"
 *   <ul><li id=1/><li id=2/></ul>
 * </div>
 */
function tree() {
  const li1 = el("li1")
  const li2 = el("li2")
  const b = el("b", tx("b"))
  const p = el("p", tx("a"), b)
  const i = el("i")
  const c = tx("c")
  const ul = el("ul", li1, li2)
  const root = el("div", p, i, c, ul)
  return { root, p, b, i, c, ul, li1, li2 }
}

function forward(walker: TreeWalker): Array<string | null> {
  const seen: Array<string | null> = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) seen.push(name(node))
  return seen
}

function backward(walker: TreeWalker): Array<string | null> {
  const seen: Array<string | null> = []
  for (let node = walker.previousNode(); node !== null; node = walker.previousNode()) seen.push(name(node))
  return seen
}

describe("NodeFilter", () => {
  it("is a global with the standard's constants, also on the prototype, and has no instances", () => {
    expect(NodeFilter.FILTER_ACCEPT).toBe(1)
    expect(NodeFilter.FILTER_REJECT).toBe(2)
    expect(NodeFilter.FILTER_SKIP).toBe(3)
    expect(NodeFilter.SHOW_ALL).toBe(0xffffffff)
    expect([NodeFilter.SHOW_ELEMENT, NodeFilter.SHOW_TEXT, NodeFilter.SHOW_COMMENT, NodeFilter.SHOW_DOCUMENT]).toEqual([1, 4, 128, 256])
    expect(NodeFilter.prototype.SHOW_TEXT).toBe(4)
    expect(() => new (NodeFilter as unknown as new () => unknown)()).toThrow(TypeError)
  })
})

describe("document.createTreeWalker", () => {
  it("stands on the root and shows every node by default", () => {
    const { root } = tree()
    const walker = document.createTreeWalker(root)
    expect(walker).toBeInstanceOf(TreeWalker)
    expect([walker.root, walker.currentNode, walker.whatToShow, walker.filter]).toEqual([root, root, 0xffffffff, null])
    expect(forward(walker)).toEqual(["p", '"a"', "b", '"b"', "i", '"c"', "ul", "li1", "li2"])
  })

  it("rejects a root that is not a node and a filter that is neither a function nor an object", () => {
    expect(() => document.createTreeWalker({} as Node)).toThrow(TypeError)
    expect(() => document.createTreeWalker(null as unknown as Node)).toThrow(TypeError)
    expect(() => document.createTreeWalker(tree().root, 1, 5 as unknown as null)).toThrow(TypeError)
  })

  it("shows only the kinds whatToShow names, and a skipped kind still lets its children through", () => {
    const { root } = tree()
    expect(forward(document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT))).toEqual(["p", "b", "i", "ul", "li1", "li2"])
    expect(forward(document.createTreeWalker(root, NodeFilter.SHOW_TEXT))).toEqual(['"a"', '"b"', '"c"'])
    expect(forward(document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT))).toHaveLength(9)
  })

  it("walks backwards with previousNode, which ends at the root as the standard's does", () => {
    const { root, li2 } = tree()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    walker.currentNode = li2
    expect(backward(walker)).toEqual(["li1", "ul", "i", "b", "p", "div"])
    expect(walker.currentNode).toBe(root)
  })

  it("FILTER_SKIP drops the node and keeps its children, FILTER_REJECT drops the subtree", () => {
    const { root } = tree()
    const answer = (verdict: number) => (node: Node) => (name(node) === "p" ? verdict : NodeFilter.FILTER_ACCEPT)
    expect(forward(document.createTreeWalker(root, NodeFilter.SHOW_ALL, answer(NodeFilter.FILTER_SKIP)))).toEqual([
      '"a"', "b", '"b"', "i", '"c"', "ul", "li1", "li2",
    ])
    expect(forward(document.createTreeWalker(root, NodeFilter.SHOW_ALL, answer(NodeFilter.FILTER_REJECT)))).toEqual([
      "i", '"c"', "ul", "li1", "li2",
    ])
    const back = document.createTreeWalker(root, NodeFilter.SHOW_ALL, answer(NodeFilter.FILTER_REJECT))
    back.currentNode = (root.kids[3] as FakeEl).kids[1]
    expect(backward(back)).toEqual(["li1", "ul", '"c"', "i", "div"])
  })

  it("takes an object with acceptNode, called on the object", () => {
    const { root } = tree()
    const seen: unknown[] = []
    const filter = {
      calls: 0,
      acceptNode(node: Node) {
        seen.push(this === filter)
        return name(node) === "i" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      },
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, filter)
    expect(walker.filter).toBe(filter)
    expect(name(walker.nextNode())).toBe("i")
    expect(seen.every(Boolean)).toBe(true)
  })

  it("moves with firstChild, lastChild, nextSibling and previousSibling over what the filter shows", () => {
    const { root, p, i, ul, li1, li2 } = tree()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    expect(walker.firstChild()).toBe(p)
    expect(walker.nextSibling()).toBe(i)
    expect(walker.nextSibling()).toBe(ul)
    expect(walker.nextSibling()).toBeNull()
    expect(walker.lastChild()).toBe(li2)
    expect(walker.previousSibling()).toBe(li1)
    expect(walker.previousSibling()).toBeNull()
    expect(walker.parentNode()).toBe(ul)
    expect(walker.parentNode()).toBe(root)
    expect(walker.parentNode()).toBeNull()
    expect(walker.currentNode).toBe(root)
  })

  it("finds a child below a skipped one, but not below a rejected one", () => {
    const { root, b } = tree()
    const hide = (verdict: number) => (node: Node) => (name(node) === "p" ? verdict : NodeFilter.FILTER_ACCEPT)
    const skipping = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, hide(NodeFilter.FILTER_SKIP))
    expect(skipping.firstChild()).toBe(b)
    const rejecting = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, hide(NodeFilter.FILTER_REJECT))
    expect(name(rejecting.firstChild())).toBe("i")
    const { root: other, p } = tree()
    const climbing = document.createTreeWalker(other, NodeFilter.SHOW_ELEMENT, hide(NodeFilter.FILTER_REJECT))
    climbing.currentNode = (p.kids[1] as FakeEl)
    // The rejected parent is not a stop for parentNode: it is passed over.
    expect(climbing.parentNode()).toBe(other)
  })

  it("does not leave the root, for parentNode, nextNode or the sibling moves", () => {
    const { ul, li1, li2 } = tree()
    const walker = document.createTreeWalker(ul, NodeFilter.SHOW_ELEMENT)
    expect(walker.parentNode()).toBeNull()
    expect(walker.nextSibling()).toBeNull()
    expect(walker.previousNode()).toBeNull()
    expect(walker.nextNode() === li1).toBe(true)
    expect(walker.nextNode() === li2).toBe(true)
    expect(walker.nextNode()).toBeNull()
    expect(walker.currentNode === li2).toBe(true)
  })

  it("takes a currentNode outside the root, and rejects a value that is not a node", () => {
    const { root } = tree()
    const walker = document.createTreeWalker(root)
    const outside = el("x")
    walker.currentNode = outside
    expect(walker.currentNode).toBe(outside)
    expect(() => {
      walker.currentNode = null as unknown as Node
    }).toThrow(TypeError)
  })

  it("throws InvalidStateError when a filter uses the walker that is running it", () => {
    const { root } = tree()
    const walker: TreeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ALL, () => {
      walker.nextNode()
      return NodeFilter.FILTER_ACCEPT
    })
    expect(() => walker.nextNode()).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    const harmless = document.createTreeWalker(root)
    expect(name(harmless.nextNode())).toBe("p")
  })

  it("keeps a walker usable after its filter throws", () => {
    const { root } = tree()
    let fail = true
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL, () => {
      if (fail) throw new Error("boom")
      return NodeFilter.FILTER_ACCEPT
    })
    expect(() => walker.nextNode()).toThrow("boom")
    fail = false
    expect(name(walker.nextNode())).toBe("p")
  })
})
