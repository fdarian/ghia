// The DOM shape of the nodes Solid builds, without a window. The mounted behaviour is in
// dom-members.test.tsx.
import { describe, expect, it } from "vitest"
import { DOM_BINDING, Element, HTMLElement, Node, SVGElement, Text } from "@ghia/native/host"
import {
  createHostElement,
  createHostText,
  HostElement,
  HostText,
  insertHostNode,
  removeHostNode,
  setHostProperty,
} from "../host.js"

describe("the nodes Solid builds", () => {
  it("is an HTMLElement for a div, an SVGElement for an svg and its shapes, and Text for text", () => {
    const div = createHostElement("div")
    const svg = createHostElement("svg")
    const path = createHostElement("path")
    for (const node of [div, svg, path]) {
      expect(node instanceof Element).toBe(true)
      expect(node instanceof Node).toBe(true)
      expect(node.kind).toBe("element")
    }
    expect(div instanceof HostElement).toBe(true)
    expect(div instanceof HTMLElement).toBe(true)
    expect(div instanceof SVGElement).toBe(false)
    expect(svg instanceof SVGElement).toBe(true)
    expect(path instanceof SVGElement).toBe(true)
    expect(path instanceof HTMLElement).toBe(false)
    const text = createHostText("t")
    expect(text instanceof HostText).toBe(true)
    expect(text instanceof Text).toBe(true)
    expect(text instanceof Element).toBe(false)
  })

  it("gives an svg shape the members and fields of a host element", () => {
    const path = createHostElement("path")
    expect(path.elementType).toBe("path")
    expect(path.mounted).toBe(false)
    expect(path.childList).toEqual([])
    expect(typeof path.focus).toBe("function")
    expect(typeof path.getBoundingClientRect).toBe("function")
    expect(typeof path.addEventListener).toBe("function")
    expect(typeof path.scrollIntoView).toBe("function")
    expect(Object.getPrototypeOf(path)).toBe(Object.getPrototypeOf(createHostElement("circle")))
    expect(Object.getPrototypeOf(path)).not.toBe(Object.getPrototypeOf(createHostElement("div")))
  })

  it("gives tagName and localName", () => {
    expect(createHostElement("div").tagName).toBe("DIV")
    expect(createHostElement("div").localName).toBe("div")
    expect(createHostElement("linearGradient").tagName).toBe("linearGradient")
    expect(createHostElement("linearGradient").localName).toBe("linearGradient")
  })

  it("throws Illegal constructor for a public class", () => {
    expect(() => Reflect.construct(HTMLElement, [])).toThrow("Illegal constructor")
    expect(() => Reflect.construct(Node, [])).toThrow("Illegal constructor")
  })

  it("reads attributes and dataset from the props", () => {
    const el = createHostElement("div")
    setHostProperty(el, "className", "card")
    setHostProperty(el, "data-row-id", "r1")
    setHostProperty(el, "data-index", 3)
    setHostProperty(el, "onClick", () => {})
    expect(el.getAttributeNames().sort()).toEqual(["class", "data-index", "data-row-id"])
    expect(el.className).toBe("card")
    expect(el.dataset).toEqual({ rowId: "r1", index: "3" })
    expect(el.hasAttribute("data-index")).toBe(true)
    expect(el.hasAttribute("onClick")).toBe(false)
  })

  describe("tree", () => {
    function build() {
      const root = createHostElement("div")
      const a = createHostText("a")
      const first = createHostElement("span")
      const second = createHostElement("label")
      const deep = createHostElement("code")
      const b = createHostText("b")
      for (const child of [a, first, second, b]) insertHostNode(root, child)
      insertHostNode(second, deep)
      return { root, a, first, second, deep, b }
    }

    it("walks parents, children and siblings, and text among them", () => {
      const t = build()
      expect(t.root.childNodes).toEqual([t.a, t.first, t.second, t.b])
      expect(t.root.children).toEqual([t.first, t.second])
      expect(t.root.firstChild).toBe(t.a)
      expect(t.root.lastChild).toBe(t.b)
      expect(t.deep.parentNode).toBe(t.second)
      expect(t.deep.parentElement).toBe(t.second)
      expect(t.root.parentNode).toBeNull()
      expect(t.first.previousSibling).toBe(t.a)
      expect(t.first.nextElementSibling).toBe(t.second)
      expect(t.second.nextSibling).toBe(t.b)
      expect(t.second.previousElementSibling).toBe(t.first)
      expect(t.a.nodeType).toBe(3)
      expect(t.a.textContent).toBe("a")
      expect(t.a.parentElement).toBe(t.root)
      expect(t.root.textContent).toBe("ab")
      expect(t.root.contains(t.deep)).toBe(true)
      expect(t.second.contains(t.first)).toBe(false)
      expect(t.first.compareDocumentPosition(t.deep)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(t.deep.compareDocumentPosition(t.root)).toBe(Node.DOCUMENT_POSITION_CONTAINS | Node.DOCUMENT_POSITION_PRECEDING)
    })

    it("follows an insert before a sibling and a removal", () => {
      const t = build()
      insertHostNode(t.root, t.b, t.first)
      expect(t.root.childNodes).toEqual([t.a, t.b, t.first, t.second])
      removeHostNode(t.root, t.first)
      expect(t.root.childNodes).toEqual([t.a, t.b, t.second])
      expect(t.first.parentNode).toBeNull()
    })

    it("is not connected until it is in a mounted root", () => {
      const t = build()
      expect(t.root.isConnected).toBe(false)
      expect(t.a.isConnected).toBe(false)
    })

    it("exposes the binding the members read", () => {
      const t = build()
      const binding = t.root[DOM_BINDING]()
      expect(binding.children).toEqual([t.a, t.first, t.second, t.b])
      expect(binding.type).toBe("div")
      expect(binding.root).toBeNull()
      expect(t.root[DOM_BINDING]()).toBe(binding)
    })
  })
})
