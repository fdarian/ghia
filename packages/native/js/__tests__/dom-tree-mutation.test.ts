import { afterEach, describe, expect, it } from "vitest"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { document, installElementSource, type DomNodeFactory } from "../events/window-target.js"
import { createRendererState } from "../renderer-state.js"
import type { NativeRenderer } from "../host.js"
import { defineDomMembers } from "../dom-members.js"
import "../dom-globals.js"

/** The tree an adapter keeps, with the two primitives the DOM members are written over. */
class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeTx> = []
  readonly log: string[] = []

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
    }
  }
}

function detach(node: FakeEl | FakeTx): void {
  const parent = node.parent
  if (parent === null) return
  parent.kids.splice(parent.kids.indexOf(node), 1)
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
    insertBefore(child, before) {
      const node = child as unknown as FakeEl | FakeTx
      detach(node)
      const index = before === null ? element.kids.length : element.kids.indexOf(before as unknown as FakeEl)
      element.kids.splice(index, 0, node)
      node.parent = element
      element.log.push(`insert ${label(node)}`)
    },
    removeChild(child) {
      detach(child as unknown as FakeEl | FakeTx)
      element.log.push(`remove ${label(child as unknown as FakeEl | FakeTx)}`)
    },
    createText: (data) => new FakeTx(data) as unknown as Text,
  }
}

function label(node: FakeEl | FakeTx): string {
  return node instanceof FakeEl ? `<${node.type}>` : `"${node.text}"`
}

defineDomMembers(FakeEl.prototype, (element: FakeEl) => ({
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

/** The tree as text: `<div><b/>"x"</div>`. */
function shape(node: FakeEl | FakeTx): string {
  if (node instanceof FakeTx) return `"${node.text}"`
  return `<${node.type}>${node.kids.map(shape).join("")}</${node.type}>`
}

function code(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof DOMException) return error.name
    throw error
  }
  return "no error"
}

describe("Node.appendChild and insertBefore", () => {
  it("returns the node and places it last, or before the reference", () => {
    const a = el("a")
    const b = el("b")
    const c = el("c")
    const parent = el("div")
    expect(parent.appendChild(a)).toBe(a)
    expect(parent.insertBefore(b, a)).toBe(b)
    expect(parent.insertBefore(c, null)).toBe(c)
    expect(shape(parent)).toBe("<div><b></b><a></a><c></c></div>")
  })

  it("moves a node that has a parent, and leaves one inserted before itself where it is", () => {
    const a = el("a")
    const b = el("b")
    const c = el("c")
    const parent = el("div", a, b, c)
    const other = el("p")
    other.appendChild(b)
    expect(shape(parent)).toBe("<div><a></a><c></c></div>")
    parent.insertBefore(a, a)
    expect(shape(parent)).toBe("<div><a></a><c></c></div>")
  })

  it("throws HierarchyRequestError for an ancestor, the node itself, a text parent and a document", () => {
    const inner = el("i")
    const outer = el("o", inner)
    expect(code(() => inner.appendChild(outer))).toBe("HierarchyRequestError")
    expect(code(() => outer.appendChild(outer))).toBe("HierarchyRequestError")
    expect(code(() => new FakeTx("t").appendChild(el("a")))).toBe("HierarchyRequestError")
    expect(code(() => el("a").appendChild(document))).toBe("HierarchyRequestError")
    expect(code(() => document.appendChild(el("a")))).toBe("HierarchyRequestError")
  })

  it("throws NotFoundError for a reference that is not a child, TypeError for what is not a Node", () => {
    const parent = el("div", el("a"))
    expect(code(() => parent.insertBefore(el("b"), el("c")))).toBe("NotFoundError")
    expect(() => parent.appendChild({} as Node)).toThrow(TypeError)
    expect(() => parent.insertBefore(el("b"), {} as Node)).toThrow(TypeError)
  })

  it("changes nothing when it throws", () => {
    const inner = el("i")
    const outer = el("o", inner)
    code(() => inner.appendChild(outer))
    expect(shape(outer)).toBe("<o><i></i></o>")
  })
})

describe("Node.removeChild and replaceChild", () => {
  it("removeChild returns the child, and a non-child is a NotFoundError", () => {
    const a = el("a")
    const parent = el("div", a)
    expect(parent.removeChild(a)).toBe(a)
    expect(a.parentNode).toBeNull()
    expect(code(() => parent.removeChild(a))).toBe("NotFoundError")
  })

  it("replaceChild returns the old child and puts the node in its place", () => {
    const [a, b, c, n] = [el("a"), el("b"), el("c"), el("n")]
    const parent = el("div", a, b, c)
    expect(parent.replaceChild(n, b)).toBe(b)
    expect(shape(parent)).toBe("<div><a></a><n></n><c></c></div>")
    expect(b.parentNode).toBeNull()
  })

  it("replaceChild moves a sibling that follows the child into its place", () => {
    const [a, b, c] = [el("a"), el("b"), el("c")]
    const parent = el("div", a, b, c)
    parent.replaceChild(b, a)
    expect(shape(parent)).toBe("<div><b></b><c></c></div>")
  })

  it("replaceChild with an ancestor or a stranger throws and keeps the child", () => {
    const [a, parent] = [el("a"), el("div")]
    parent.appendChild(a)
    expect(code(() => parent.replaceChild(el("n"), el("x")))).toBe("NotFoundError")
    expect(code(() => a.replaceChild(parent, el("x")))).toBe("NotFoundError")
    const inner = el("i")
    a.appendChild(inner)
    expect(code(() => inner.replaceChild(parent, el("x")))).toBe("NotFoundError")
    expect(code(() => a.replaceChild(parent, inner))).toBe("HierarchyRequestError")
    expect(shape(a)).toBe("<a><i></i></a>")
  })
})

describe("textContent, data and nodeValue setters", () => {
  it("an element's textContent replaces every child with one text node, and \"\" or null removes all", () => {
    const parent = el("div", el("a"), el("b"))
    parent.textContent = "hello"
    expect(shape(parent)).toBe('<div>"hello"</div>')
    expect(parent.textContent).toBe("hello")
    parent.textContent = ""
    expect(shape(parent)).toBe("<div></div>")
    parent.textContent = "x"
    parent.textContent = null
    expect(shape(parent)).toBe("<div></div>")
  })

  it("a text node's textContent, data and nodeValue set its data", () => {
    const text = new FakeTx("a")
    text.data = "b"
    expect(text.nodeValue).toBe("b")
    text.nodeValue = "c"
    expect(text.textContent).toBe("c")
    text.textContent = "d"
    expect(text.data).toBe("d")
    expect(text.length).toBe(1)
    text.data = null as unknown as string
    expect(text.data).toBe("")
  })
})

describe("ChildNode", () => {
  it("remove takes a node out and does nothing for one without a parent", () => {
    const a = el("a")
    const parent = el("div", a)
    a.remove()
    expect(shape(parent)).toBe("<div></div>")
    expect(() => a.remove()).not.toThrow()
  })

  it("before and after insert nodes and strings in order, beside the node", () => {
    const a = el("a")
    const parent = el("div", a)
    a.before(el("x"), "s")
    a.after("t", el("y"))
    expect(shape(parent)).toBe('<div><x></x>"s"<a></a>"t"<y></y></div>')
  })

  it("before and after do nothing without a parent", () => {
    expect(() => el("a").before(el("b"))).not.toThrow()
    expect(() => new FakeTx("a").after("b")).not.toThrow()
  })

  it("before and after move siblings that are among the nodes", () => {
    const [a, b, c, d] = [el("a"), el("b"), el("c"), el("d")]
    const parent = el("div", a, b, c, d)
    c.before(d, b)
    expect(shape(parent)).toBe("<div><a></a><d></d><b></b><c></c></div>")
    a.after(c, d)
    expect(shape(parent)).toBe("<div><a></a><c></c><d></d><b></b></div>")
  })

  it("before and after with the node itself among the nodes put them where it was", () => {
    const [a, b, c] = [el("a"), el("b"), el("c")]
    const parent = el("div", a, b, c)
    b.before(c, b)
    expect(shape(parent)).toBe("<div><a></a><c></c><b></b></div>")
    const [x, y] = [el("x"), el("y")]
    const second = el("div", x, y)
    x.after(y, x)
    expect(shape(second)).toBe("<div><y></y><x></x></div>")
  })

  it("replaceWith puts the nodes where it was, and an element or text can be replaced", () => {
    const [a, b] = [el("a"), el("b")]
    const text = new FakeTx("t")
    const parent = el("div", a, text, b)
    a.replaceWith("s", el("n"))
    expect(shape(parent)).toBe('<div>"s"<n></n>"t"<b></b></div>')
    text.replaceWith(b)
    expect(shape(parent)).toBe('<div>"s"<n></n><b></b></div>')
  })

  it("replaceWith itself changes nothing, and with itself among others keeps them in order", () => {
    const [a, b] = [el("a"), el("b")]
    const parent = el("div", a, b)
    a.replaceWith(a)
    expect(shape(parent)).toBe("<div><a></a><b></b></div>")
    a.replaceWith(b, a)
    expect(shape(parent)).toBe("<div><b></b><a></a></div>")
  })

  it("replaceWith keeps the node when one of the nodes cannot go there", () => {
    const [a, outer] = [el("a"), el("o")]
    const parent = el("div", a)
    outer.appendChild(parent)
    expect(code(() => a.replaceWith(outer))).toBe("HierarchyRequestError")
    expect(shape(parent)).toBe("<div><a></a></div>")
  })
})

describe("ParentNode", () => {
  it("append and prepend take nodes and strings", () => {
    const parent = el("div", el("m"))
    parent.append(el("a"), "s")
    parent.prepend("t", el("b"))
    expect(shape(parent)).toBe('<div>"t"<b></b><m></m><a></a>"s"</div>')
  })

  it("prepend and append move children that are among the nodes", () => {
    const [a, b, c] = [el("a"), el("b"), el("c")]
    const parent = el("div", a, b, c)
    parent.prepend(c, a)
    expect(shape(parent)).toBe("<div><c></c><a></a><b></b></div>")
    parent.append(c, a)
    expect(shape(parent)).toBe("<div><b></b><c></c><a></a></div>")
  })

  it("replaceChildren replaces every child, and with none empties the element", () => {
    const [a, b] = [el("a"), el("b")]
    const parent = el("div", a, b)
    parent.replaceChildren("s", b)
    expect(shape(parent)).toBe('<div>"s"<b></b></div>')
    expect(a.parentNode).toBeNull()
    parent.replaceChildren()
    expect(shape(parent)).toBe("<div></div>")
  })

  it("replaceChildren with an ancestor throws before it removes anything", () => {
    const inner = el("i")
    const parent = el("div", inner)
    expect(code(() => inner.replaceChildren(parent))).toBe("HierarchyRequestError")
    expect(shape(parent)).toBe("<div><i></i></div>")
  })

  it("insertAdjacentElement uses the four positions, in any letter case, and returns the element", () => {
    const target = el("t", el("c"))
    const parent = el("div", target)
    expect(target.insertAdjacentElement("beforebegin", el("bb"))?.localName).toBe("bb")
    target.insertAdjacentElement("afterBegin", el("ab"))
    target.insertAdjacentElement("BEFOREEND", el("be"))
    target.insertAdjacentElement("afterend", el("ae"))
    expect(shape(parent)).toBe("<div><bb></bb><t><ab></ab><c></c><be></be></t><ae></ae></div>")
  })

  it("insertAdjacentElement beside a node without a parent returns null, and a bad position is a SyntaxError", () => {
    const lone = el("a")
    expect(lone.insertAdjacentElement("beforebegin", el("b"))).toBeNull()
    expect(lone.insertAdjacentElement("afterend", el("b"))).toBeNull()
    expect(code(() => lone.insertAdjacentElement("inside", el("b")))).toBe("SyntaxError")
    expect(() => lone.insertAdjacentElement("afterbegin", {} as never)).toThrow(TypeError)
  })

  it("insertAdjacentElement moves an element that is already in the tree", () => {
    const [a, b] = [el("a"), el("b")]
    const parent = el("div", a, b)
    expect(b.insertAdjacentElement("beforebegin", b)).toBe(b)
    expect(shape(parent)).toBe("<div><a></a><b></b></div>")
    a.insertAdjacentElement("afterend", a)
    expect(shape(parent)).toBe("<div><a></a><b></b></div>")
    a.insertAdjacentElement("beforebegin", b)
    expect(shape(parent)).toBe("<div><b></b><a></a></div>")
  })

  it("insertAdjacentText makes a text node and returns nothing", () => {
    const target = el("t")
    const parent = el("div", target)
    expect(target.insertAdjacentText("afterend", "after")).toBeUndefined()
    target.insertAdjacentText("afterbegin", "in")
    expect(shape(parent)).toBe('<div><t>"in"</t>"after"</div>')
    expect(el("lone").insertAdjacentText("beforebegin", "x")).toBeUndefined()
  })
})

describe("what the adapter is told", () => {
  it("calls the adapter's primitives once per node, for a move too", () => {
    const [a, b] = [el("a"), el("b")]
    const parent = el("div", a)
    parent.appendChild(b)
    parent.insertBefore(b, a)
    parent.removeChild(a)
    expect(parent.log).toEqual(["insert <b>", "insert <b>", "remove <a>"])
  })
})

describe("document.createElement and createTextNode", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const factory: DomNodeFactory = {
    createElement: (type) => new FakeEl(type),
    createTextNode: (data) => new FakeTx(data) as unknown as Text,
  }

  function mountWindow(nodeFactory?: DomNodeFactory): void {
    const fake = { applyBatch: () => [] as number[] }
    const renderer = fake as unknown as NativeRenderer
    const binding = createRendererState(renderer).attach()
    cleanups.push(() => binding.detach(), installElementSource(fake, () => undefined, undefined, nodeFactory) as () => void)
  }

  it("throws before a root is mounted", () => {
    expect(() => document.createElement("div")).toThrow(/mounted/)
    expect(() => document.createTextNode("x")).toThrow(/mounted/)
  })

  it("makes an element of the root's factory, with the name lowercased", () => {
    mountWindow(factory)
    const div = document.createElement("DIV") as unknown as FakeEl
    expect(div).toBeInstanceOf(FakeEl)
    expect(div.type).toBe("div")
    expect(div.parentNode).toBeNull()
    expect((document.createTextNode("hi") as unknown as FakeTx).text).toBe("hi")
    expect((document.createTextNode(5 as unknown as string) as unknown as FakeTx).text).toBe("5")
  })

  it("throws InvalidCharacterError for a bad name and NotSupportedError for a type Ghia does not draw", () => {
    mountWindow(factory)
    expect(code(() => document.createElement("a b"))).toBe("InvalidCharacterError")
    expect(code(() => document.createElement(""))).toBe("InvalidCharacterError")
    expect(code(() => document.createElement("marquee"))).toBe("NotSupportedError")
  })

  it("createElementNS keeps the case for the SVG namespace and rejects a type of the other kind", () => {
    mountWindow(factory)
    const svg = "http://www.w3.org/2000/svg"
    const html = "http://www.w3.org/1999/xhtml"
    expect((document.createElementNS(svg, "linearGradient") as unknown as FakeEl).type).toBe("linearGradient")
    expect((document.createElementNS(svg, "svg") as unknown as FakeEl).type).toBe("svg")
    expect((document.createElementNS(html, "div") as unknown as FakeEl).type).toBe("div")
    expect(code(() => document.createElementNS(svg, "div"))).toBe("NotSupportedError")
    expect(code(() => document.createElementNS(html, "path"))).toBe("NotSupportedError")
    expect(code(() => document.createElementNS(null, "div"))).toBe("NotSupportedError")
  })

  it("throws when the root registered no factory", () => {
    mountWindow()
    expect(() => document.createElement("div")).toThrow(/cannot make nodes/)
  })
})
