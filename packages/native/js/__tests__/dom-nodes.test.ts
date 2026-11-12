import { describe, expect, it } from "vitest"
import {
  CharacterData,
  Document,
  DocumentFragment,
  DOM_BINDING,
  Element,
  HTMLElement,
  Node,
  ShadowRoot,
  SVGElement,
  Text,
  type ElementBinding,
  type TextBinding,
} from "../dom/nodes.js"
import { document, GpuixDocument, installElementSource } from "../events/window-target.js"
import { mountedRenderers } from "../mounted-renderer.js"
import type { NativeRenderer } from "../host.js"
import { defineDomMembers } from "../dom-members.js"
import "../dom-globals.js"

type Props = Record<string, unknown>

/** An element of the shape an adapter builds, with the tree kept the way an adapter keeps it. */
class FakeHtml extends HTMLElement {
  parent: Node | null = null
  readonly kids: Array<FakeHtml | FakeText> = []
  connected = true
  constructor(
    readonly type: string,
    readonly props: Props = {}
  ) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    return elementBinding(this)
  }
}

class FakeSvg extends SVGElement {
  parent: FakeHtml | null = null
  readonly kids: Array<FakeHtml | FakeText> = []
  connected = true
  constructor(
    readonly type: string,
    readonly props: Props = {}
  ) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    return elementBinding(this)
  }
}

class FakeText extends Text {
  parent: FakeHtml | null = null
  constructor(public text: string) {
    super()
  }
  [DOM_BINDING](): TextBinding {
    return { parent: this.parent as Node | null, children: [], connected: true, root: null, data: this.text }
  }
}

function elementBinding(element: FakeHtml | FakeSvg): ElementBinding {
  return {
    parent: element.parent as Node | null,
    children: element.kids as readonly Node[],
    connected: element.connected,
    root: null,
    type: element.type,
    prop: (name) => element.props[name],
    propNames: () => Object.keys(element.props),
    style: {},
  }
}

defineDomMembers(FakeHtml.prototype, (element: FakeHtml) => ({
  listeners: undefined as never,
  style: {},
  connected: element.connected,
  prop: (name) => element.props[name],
  propNames: () => Object.keys(element.props),
  style: {},
}))
defineDomMembers(FakeSvg.prototype, (element: FakeSvg) => ({
  listeners: undefined as never,
  style: {},
  connected: element.connected,
  prop: (name) => element.props[name],
  propNames: () => Object.keys(element.props),
  style: {},
}))

function place(parent: FakeHtml, ...children: Array<FakeHtml | FakeText>): void {
  for (const child of children) {
    child.parent = parent
    parent.kids.push(child)
  }
}

describe("DOM classes", () => {
  it("makes an adapter element an HTMLElement, Element and Node, and not an SVGElement or Text", () => {
    const div = new FakeHtml("div")
    expect(div instanceof HTMLElement).toBe(true)
    expect(div instanceof Element).toBe(true)
    expect(div instanceof Node).toBe(true)
    expect(div instanceof SVGElement).toBe(false)
    expect(div instanceof Text).toBe(false)
    expect(div instanceof Document).toBe(false)
    expect(div instanceof DocumentFragment).toBe(false)
    expect(div instanceof ShadowRoot).toBe(false)
  })

  it("makes an svg element an SVGElement, Element and Node, and not an HTMLElement", () => {
    const path = new FakeSvg("path")
    expect(path instanceof SVGElement).toBe(true)
    expect(path instanceof Element).toBe(true)
    expect(path instanceof Node).toBe(true)
    expect(path instanceof HTMLElement).toBe(false)
  })

  it("makes text a Text, CharacterData and Node", () => {
    const text = new FakeText("hi")
    expect(text instanceof Text).toBe(true)
    expect(text instanceof CharacterData).toBe(true)
    expect(text instanceof Node).toBe(true)
    expect(text instanceof Element).toBe(false)
  })

  it("throws Illegal constructor for a public class, and constructs a subclass", () => {
    for (const illegal of [Node, CharacterData, Text, Element, HTMLElement, SVGElement, Document, DocumentFragment, ShadowRoot]) {
      expect(() => Reflect.construct(illegal, [])).toThrow(new TypeError("Illegal constructor"))
    }
    expect(new FakeHtml("div")).toBeInstanceOf(HTMLElement)
  })

  it("keeps the DOM class names", () => {
    expect(HTMLElement.name).toBe("HTMLElement")
    expect(Node.name).toBe("Node")
  })

  it("is the set a second copy of the module finds, so identity holds across copies", () => {
    const set = Reflect.get(globalThis, Symbol.for("@ghia/native/dom-classes")) as Record<string, unknown>
    expect(set.HTMLElement).toBe(HTMLElement)
    expect(set.Node).toBe(Node)
  })

  it("is the global class where the runtime has none", () => {
    expect(globalThis.HTMLElement as unknown).toBe(HTMLElement)
    expect(globalThis.Node as unknown).toBe(Node)
    expect(globalThis.SVGElement as unknown).toBe(SVGElement)
    expect(globalThis.Text as unknown).toBe(Text)
    expect(new FakeHtml("div") instanceof globalThis.HTMLElement).toBe(true)
  })

  it("has the node type constants on the class and the prototype", () => {
    expect(Node.ELEMENT_NODE).toBe(1)
    expect(new FakeHtml("div").TEXT_NODE).toBe(3)
    expect(Node.DOCUMENT_POSITION_CONTAINED_BY).toBe(16)
  })
})

describe("tree members", () => {
  /**
   * <div>            root
   *   "a"            text
   *   <span/>        first
   *   <p>            second
   *     <b/>         deep
   *   </p>
   *   "b"
   * </div>
   */
  function tree() {
    const root = new FakeHtml("div")
    const a = new FakeText("a")
    const first = new FakeHtml("span")
    const second = new FakeHtml("p")
    const deep = new FakeHtml("b")
    const b = new FakeText("b")
    place(root, a, first, second, b)
    place(second, deep)
    return { root, a, first, second, deep, b }
  }

  it("walks parents, children and siblings", () => {
    const t = tree()
    expect(t.first.parentNode).toBe(t.root)
    expect(t.first.parentElement).toBe(t.root)
    expect(t.root.parentNode).toBeNull()
    expect(t.root.parentElement).toBeNull()
    expect(t.root.childNodes).toEqual([t.a, t.first, t.second, t.b])
    expect(t.root.firstChild).toBe(t.a)
    expect(t.root.lastChild).toBe(t.b)
    expect(t.first.previousSibling).toBe(t.a)
    expect(t.first.nextSibling).toBe(t.second)
    expect(t.a.previousSibling).toBeNull()
    expect(t.b.nextSibling).toBeNull()
    expect(t.deep.previousSibling).toBeNull()
    expect(t.deep.nextSibling).toBeNull()
    expect(t.root.hasChildNodes()).toBe(true)
    expect(t.deep.hasChildNodes()).toBe(false)
  })

  it("lists elements only in children and the element siblings", () => {
    const t = tree()
    expect(t.root.children).toEqual([t.first, t.second])
    expect(t.root.childElementCount).toBe(2)
    expect(t.root.firstElementChild).toBe(t.first)
    expect(t.root.lastElementChild).toBe(t.second)
    expect(t.first.previousElementSibling).toBeNull()
    expect(t.first.nextElementSibling).toBe(t.second)
    expect(t.second.previousElementSibling).toBe(t.first)
    expect(t.second.nextElementSibling).toBeNull()
    expect(t.deep.firstElementChild).toBeNull()
  })

  it("answers contains inclusive, like the DOM", () => {
    const t = tree()
    expect(t.root.contains(t.root)).toBe(true)
    expect(t.root.contains(t.deep)).toBe(true)
    expect(t.root.contains(t.a)).toBe(true)
    expect(t.deep.contains(t.root)).toBe(false)
    expect(t.first.contains(t.second)).toBe(false)
    expect(t.root.contains(null)).toBe(false)
  })

  it("compares document position", () => {
    const t = tree()
    const stray = new FakeHtml("div")
    expect(t.root.compareDocumentPosition(t.root)).toBe(0)
    expect(t.root.compareDocumentPosition(t.deep)).toBe(Node.DOCUMENT_POSITION_CONTAINED_BY | Node.DOCUMENT_POSITION_FOLLOWING)
    expect(t.deep.compareDocumentPosition(t.root)).toBe(Node.DOCUMENT_POSITION_CONTAINS | Node.DOCUMENT_POSITION_PRECEDING)
    expect(t.first.compareDocumentPosition(t.second)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(t.second.compareDocumentPosition(t.first)).toBe(Node.DOCUMENT_POSITION_PRECEDING)
    expect(t.a.compareDocumentPosition(t.deep)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(t.deep.compareDocumentPosition(t.a)).toBe(Node.DOCUMENT_POSITION_PRECEDING)
    const apart = t.first.compareDocumentPosition(stray)
    expect(apart & Node.DOCUMENT_POSITION_DISCONNECTED).toBe(Node.DOCUMENT_POSITION_DISCONNECTED)
    expect(apart & Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC).toBe(Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC)
    // Consistent: the order of two trees does not change between calls and mirrors itself.
    const back = stray.compareDocumentPosition(t.first)
    expect(t.first.compareDocumentPosition(stray)).toBe(apart)
    expect(back & (Node.DOCUMENT_POSITION_PRECEDING | Node.DOCUMENT_POSITION_FOLLOWING)).not.toBe(
      apart & (Node.DOCUMENT_POSITION_PRECEDING | Node.DOCUMENT_POSITION_FOLLOWING)
    )
  })

  it("finds the root node: the document for a mounted node, else the top of its tree", () => {
    const t = tree()
    expect(t.deep.getRootNode()).toBe(document)
    t.root.connected = false
    t.second.connected = false
    t.deep.connected = false
    expect(t.deep.getRootNode()).toBe(t.root)
    expect(t.root.getRootNode()).toBe(t.root)
    expect(document.getRootNode()).toBe(document)
  })

  it("joins the text of the descendants for textContent", () => {
    const t = tree()
    place(t.deep, new FakeText("!"))
    expect(t.root.textContent).toBe("a!b")
    expect(t.a.textContent).toBe("a")
  })

  it("gives a text node its data, value, name and type", () => {
    const text = new FakeText("hello")
    expect(text.nodeType).toBe(3)
    expect(text.nodeName).toBe("#text")
    expect(text.data).toBe("hello")
    expect(text.nodeValue).toBe("hello")
    expect(text.textContent).toBe("hello")
    expect(text.length).toBe(5)
    text.text = "changed"
    expect(text.data).toBe("changed")
  })

  it("answers isConnected and ownerDocument for text, where no adapter defines them", () => {
    const text = new FakeText("hi")
    expect(text.isConnected).toBe(true)
    expect(text.ownerDocument).toBe(document)
  })
})

describe("element members", () => {
  it("uppercases tagName for HTML and keeps the case for SVG", () => {
    const div = new FakeHtml("div")
    expect(div.tagName).toBe("DIV")
    expect(div.localName).toBe("div")
    expect(div.nodeName).toBe("DIV")
    expect(div.nodeType).toBe(1)
    const gradient = new FakeSvg("linearGradient")
    expect(gradient.tagName).toBe("linearGradient")
    expect(gradient.localName).toBe("linearGradient")
    expect(gradient.nodeName).toBe("linearGradient")
    expect(new FakeHtml("virtual-list").tagName).toBe("VIRTUAL-LIST")
  })

  it("reads className from className or class", () => {
    expect(new FakeHtml("div", { className: "card big" }).className).toBe("card big")
    expect(new FakeHtml("div", { class: "card" }).className).toBe("card")
    expect(new FakeHtml("div").className).toBe("")
  })

  it("reads class before className, as getAttribute does", () => {
    const both = new FakeHtml("div", { className: "from-name", class: "from-attribute" })
    expect(both.className).toBe("from-attribute")
    expect(both.className).toBe(both.getAttribute("class"))
    expect(new FakeHtml("div", { class: "from-attribute", className: "from-name" }).className).toBe("from-attribute")
    expect(new FakeHtml("div", { className: "from-name", class: undefined }).className).toBe("from-name")
  })

  it("lists attributes that hold a value, hasAttribute and dataset", () => {
    const el = new FakeHtml("div", {
      className: "x",
      "data-index": 7,
      "data-row-id": "r1",
      "aria-label": "go",
      disabled: false,
      onClick: () => {},
      style: { width: 1 },
      children: "text",
    })
    expect(el.getAttributeNames()).toEqual(["class", "data-index", "data-row-id", "aria-label"])
    expect(el.hasAttribute("data-index")).toBe(true)
    expect(el.hasAttribute("class")).toBe(true)
    expect(el.hasAttribute("disabled")).toBe(false)
    expect(el.hasAttribute("missing")).toBe(false)
    expect(el.dataset).toEqual({ index: "7", rowId: "r1" })
    expect(el.dataset).toBe(el.dataset)
  })
})

describe("document", () => {
  it("is a Document and a Node of type 9, and not an element", () => {
    expect(document instanceof Document).toBe(true)
    expect(document instanceof GpuixDocument).toBe(true)
    expect(document instanceof Node).toBe(true)
    expect(document instanceof Element).toBe(false)
    expect(document.nodeType).toBe(9)
    expect(document.nodeName).toBe("#document")
    expect(document.parentNode).toBeNull()
    expect(document.ownerDocument).toBeNull()
    expect(document.textContent).toBeNull()
    expect(document.childNodes).toEqual([document.documentElement])
  })

  it("has a stand-in html, head and body while no root is mounted", () => {
    const html = document.documentElement
    expect(html).toBeInstanceOf(HTMLElement)
    expect(html.tagName).toBe("HTML")
    expect(html.parentNode).toBe(document)
    expect(html.isConnected).toBe(true)
    expect([...html.children]).toEqual([document.head, document.body])
    expect(document.head.tagName).toBe("HEAD")
    expect(document.body.tagName).toBe("BODY")
    expect(document.body.parentNode).toBe(html)
    expect(document.scrollingElement).toBe(html)
    expect(document.documentElement).toBe(html)
    expect(html.ownerDocument).toBe(document)
    expect(html.getRootNode()).toBe(document)
    expect(document.contains(document.body)).toBe(true)
    expect(html.getBoundingClientRect().width).toBe(0)
    expect(html.offsetParent).toBeNull()
    expect(html.scrollTop).toBe(0)
    document.body.setAttribute("data-x", "1")
    expect(document.body.getAttribute("data-x")).toBe("1")
    document.body.removeAttribute("data-x")
    expect(document.body.hasAttribute("data-x")).toBe(false)
    expect(() => document.body.appendChild(new FakeHtml("div"))).toThrow(/no root mounted/)
  })

  it("answers with the window's elements once a root mounts, and with the stand-in again after", () => {
    const standIn = document.documentElement
    const window = mountWindow()
    expect(document.documentElement).toBe(window.html)
    expect(document.childNodes).toEqual([window.html])
    expect(standIn.isConnected).toBe(true)
    window.unmount()
    expect(document.documentElement).toBe(standIn)
  })

  /** A window whose root is `html` > `head` + `body`, the most recently mounted. */
  function mountWindow() {
    const renderer = {} as NativeRenderer
    const html = new FakeHtml("html")
    const head = new FakeHtml("head")
    const body = new FakeHtml("body")
    html.parent = document
    place(html, head)
    place(html, body)
    const remove = installElementSource(renderer, () => undefined, () => ({ html, head, body }))
    mountedRenderers().push(renderer)
    return {
      html,
      head,
      body,
      unmount() {
        mountedRenderers().splice(mountedRenderers().indexOf(renderer), 1)
        remove()
      },
    }
  }

  it("has the html and body of the window that mounted last", () => {
    const first = mountWindow()
    const second = mountWindow()
    expect(document.documentElement).toBe(second.html)
    expect(document.head).toBe(second.head)
    expect(document.body).toBe(second.body)
    expect(document.scrollingElement).toBe(second.html)
    expect(document.childNodes).toEqual([first.html, second.html])
    expect(second.html.parentNode).toBe(document)
    second.unmount()
    expect(document.documentElement).toBe(first.html)
    first.unmount()
    expect(document.documentElement).not.toBe(first.html)
    expect(document.documentElement.parentNode).toBe(document)
  })

  it("contains a mounted node, and compares against it", () => {
    const window = mountWindow()
    const mounted = new FakeHtml("div")
    place(window.body, mounted)
    const loose = new FakeHtml("div")
    loose.connected = false
    expect(document.contains(mounted)).toBe(true)
    expect(document.contains(window.html)).toBe(true)
    expect(document.contains(loose)).toBe(false)
    expect(document.compareDocumentPosition(mounted)).toBe(
      Node.DOCUMENT_POSITION_CONTAINED_BY | Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(mounted.compareDocumentPosition(document)).toBe(Node.DOCUMENT_POSITION_CONTAINS | Node.DOCUMENT_POSITION_PRECEDING)
    expect(mounted.getRootNode()).toBe(document)
    window.unmount()
  })

  it("keeps its event-target behaviour, with itself as currentTarget", () => {
    const calls: unknown[] = []
    const listener = (event: { currentTarget: unknown }) => calls.push(event.currentTarget)
    document.addEventListener("keydown", listener as never)
    expect(document.hasListeners("keydown")).toBe(true)
    const event = { type: "keydown", currentTarget: null, eventPhase: 0 }
    document.run(event as never, { immediatePropagationStopped: false } as never, false, 3, () => {})
    expect(calls).toEqual([document])
    document.removeEventListener("keydown", listener as never)
    expect(document.hasListeners("keydown")).toBe(false)
  })
})
