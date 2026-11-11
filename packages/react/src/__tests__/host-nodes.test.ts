// The DOM shape of the instances React builds, without a window: what `createInstance` returns,
// and the tree the host config keeps in JS. The mounted behaviour is in dom-members.test.tsx.
import { describe, expect, it } from "vitest"
import { DOM_BINDING, Element, HTMLElement, Node, SVGElement, Text } from "@ghia/native/host"
import { hostConfig } from "../reconciler/host-config.js"
import { linkChild, unlinkChild } from "../reconciler/host-nodes.js"
import type { Container, Instance, TextInstance } from "../types/host.js"

const container = {
  ids: { nextElementId: 0 },
  instances: new Map<number, Instance>(),
} as unknown as Container

const context = { isInsideText: false }

function element(type: string, props: Record<string, unknown> = {}): Instance {
  return hostConfig.createInstance(type as never, props as never, container, context)
}

function text(value: string): TextInstance {
  return hostConfig.createTextInstance(value, container, context)
}

describe("the nodes React builds", () => {
  it("is an HTMLElement for a div, and an SVGElement for an svg and its shapes", () => {
    const div = element("div")
    const svg = element("svg")
    const path = element("path")
    for (const node of [div, svg, path]) {
      expect(node instanceof Element).toBe(true)
      expect(node instanceof Node).toBe(true)
    }
    expect(div instanceof HTMLElement).toBe(true)
    expect(div instanceof SVGElement).toBe(false)
    expect(svg instanceof SVGElement).toBe(true)
    expect(path instanceof SVGElement).toBe(true)
    expect(path instanceof HTMLElement).toBe(false)
    expect(text("t") instanceof Text).toBe(true)
  })

  it("keeps the id, type and props fields, and the members on the prototype", () => {
    const div = element("div", { className: "a" })
    expect(typeof div.nativeId).toBe("number")
    expect(div.type).toBe("div")
    expect(div.props).toEqual({ className: "a" })
    expect(Object.keys(div)).not.toContain("focus")
    expect(typeof div.focus).toBe("function")
    expect(Object.getPrototypeOf(div)).toBe(Object.getPrototypeOf(element("div")))
    const path = element("path")
    expect(typeof path.focus).toBe("function")
    expect(typeof path.getBoundingClientRect).toBe("function")
    expect(Object.getPrototypeOf(path)).toBe(Object.getPrototypeOf(element("circle")))
  })

  it("gives tagName and localName", () => {
    expect(element("div").tagName).toBe("DIV")
    expect(element("div").localName).toBe("div")
    expect(element("linearGradient").tagName).toBe("linearGradient")
    expect(element("linearGradient").localName).toBe("linearGradient")
  })

  it("throws Illegal constructor for a public class", () => {
    expect(() => Reflect.construct(HTMLElement, [])).toThrow("Illegal constructor")
    expect(() => Reflect.construct(Node, [])).toThrow("Illegal constructor")
  })

  it("reads attributes and dataset from the props", () => {
    const el = element("div", { className: "card", "data-row-id": "r1", "data-index": 3, onClick: () => {}, children: "x" })
    expect(el.getAttributeNames().sort()).toEqual(["class", "data-index", "data-row-id"])
    expect(el.className).toBe("card")
    expect(el.dataset).toEqual({ rowId: "r1", index: "3" })
    expect(el.hasAttribute("data-index")).toBe(true)
    expect(el.hasAttribute("onClick")).toBe(false)
  })

  describe("tree", () => {
    function build() {
      const root = element("div")
      const a = text("a")
      const first = element("span")
      const second = element("p")
      const deep = element("b")
      for (const child of [a, first, second]) hostConfig.appendInitialChild(root, child)
      hostConfig.appendInitialChild(second, deep)
      return { root, a, first, second, deep }
    }

    it("keeps parents and ordered children from appendInitialChild", () => {
      const t = build()
      expect(t.root.childNodes).toEqual([t.a, t.first, t.second])
      expect(t.root.children).toEqual([t.first, t.second])
      expect(t.deep.parentNode).toBe(t.second)
      expect(t.deep.parentElement).toBe(t.second)
      expect(t.root.parentNode).toBeNull()
      expect(t.first.previousSibling).toBe(t.a)
      expect(t.first.nextElementSibling).toBe(t.second)
      expect(t.a.parentElement).toBe(t.root)
      expect(t.root.contains(t.deep)).toBe(true)
      expect(t.second.contains(t.first)).toBe(false)
      expect(t.first.compareDocumentPosition(t.deep)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(t.deep.compareDocumentPosition(t.root)).toBe(Node.DOCUMENT_POSITION_CONTAINS | Node.DOCUMENT_POSITION_PRECEDING)
      expect(t.a.nodeType).toBe(3)
      expect(t.a.data).toBe("a")
    })

    it("places before a sibling, moves a node, and removes it", () => {
      const t = build()
      linkChild(t.root, t.second, t.a)
      expect(t.root.childNodes).toEqual([t.second, t.a, t.first])
      linkChild(t.root, t.second)
      expect(t.root.childNodes).toEqual([t.a, t.first, t.second])
      linkChild(t.first, t.a)
      expect(t.root.childNodes).toEqual([t.first, t.second])
      expect(t.a.parentNode).toBe(t.first)
      unlinkChild(t.a)
      expect(t.first.childNodes).toEqual([])
      expect(t.a.parentNode).toBeNull()
      expect(() => linkChild(t.root, t.a, element("i"))).toThrow()
    })

    it("answers isConnected from the container's mounted elements", () => {
      const t = build()
      expect(t.root.isConnected).toBe(false)
      expect(t.a.isConnected).toBe(false)
      container.instances.set(t.root.nativeId, t.root)
      container.instances.set(t.second.nativeId, t.second)
      expect(t.root.isConnected).toBe(true)
      expect(t.a.isConnected).toBe(true)
      expect(t.deep.isConnected).toBe(false)
      container.instances.delete(t.root.nativeId)
      container.instances.delete(t.second.nativeId)
    })

    it("exposes the binding the members read", () => {
      const t = build()
      const binding = t.root[DOM_BINDING]()
      expect(binding.children).toEqual([t.a, t.first, t.second])
      expect(binding.parent).toBeNull()
      expect(binding.type).toBe("div")
      expect(binding.root).toBe(container)
    })
  })
})
