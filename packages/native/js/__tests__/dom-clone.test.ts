import { describe, expect, it } from "vitest"
import { DOM_BINDING, Document, HTMLElement, SVGElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { defineDomMembers } from "../dom-members.js"
import { document } from "../events/window-target.js"
import type { StyleDesc } from "../host.js"
import "../dom-globals.js"

type Props = Record<string, unknown>

/** Elements and text of one fake window, the way an adapter builds them: the window's factory is `makeElement` and `makeText`. */
class FakeElement extends HTMLElement {
  parent: FakeElement | null = null
  readonly kids: Array<FakeElement | FakeText> = []
  style: StyleDesc = {}
  constructor(
    readonly type: string,
    readonly props: Props = {}
  ) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    const element = this
    return {
      parent: element.parent as Node | null,
      children: element.kids as readonly Node[],
      connected: false,
      root: null,
      type: element.type,
      prop: (name) => element.props[name],
      propNames: () => Object.keys(element.props),
      style: element.style,
      setStyle(next) {
        element.style = next
      },
      setProp(name, value) {
        element.props[name] = value
      },
      insertBefore(child, before) {
        const node = child as unknown as FakeElement | FakeText
        node.parent = element
        const index = before === null ? element.kids.length : element.kids.indexOf(before as unknown as FakeElement)
        element.kids.splice(index, 0, node)
      },
      removeChild() {},
      createText: makeText,
      createElement: makeElement,
    }
  }
}

class FakeSvgElement extends SVGElement {
  parent: FakeElement | null = null
  readonly kids: Array<FakeElement | FakeText> = []
  style: StyleDesc = {}
  constructor(
    readonly type: string,
    readonly props: Props = {}
  ) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    return FakeElement.prototype[DOM_BINDING].call(this)
  }
}

class FakeText extends Text {
  parent: FakeElement | null = null
  constructor(public text: string) {
    super()
  }
  [DOM_BINDING](): TextBinding {
    const text = this
    return {
      parent: text.parent as Node | null,
      children: [],
      connected: false,
      root: null,
      data: text.text,
      setData(data) {
        text.text = data
      },
      createText: makeText,
    }
  }
}

function makeElement(type: string): FakeElement {
  return (type === "svg" || type === "path" ? new FakeSvgElement(type) : new FakeElement(type)) as unknown as FakeElement
}

function makeText(data: string): FakeText {
  return new FakeText(data)
}

for (const prototype of [FakeElement.prototype, FakeSvgElement.prototype]) {
  defineDomMembers(prototype, (element: FakeElement) => {
    const binding = element[DOM_BINDING]()
    return { listeners: undefined as never, connected: false, prop: binding.prop, propNames: binding.propNames, style: element.style }
  })
}

describe("cloneNode", () => {
  it("copies primitive props and the live style, and none of the handlers, refs, keys or objects", () => {
    const source = new FakeElement("div", {
      id: "box",
      className: "a b",
      "data-kind": "card",
      "aria-hidden": false,
      tabIndex: 2,
      draggable: false,
      onClick: () => {},
      ref: () => {},
      key: "k",
      children: "text",
      motion: { animate: { opacity: 1 } },
      layout: { id: "x" },
    })
    source.style = { width: 10, "--x": "1" } as StyleDesc
    const clone = source.cloneNode() as unknown as FakeElement
    expect(clone).not.toBe(source)
    expect(clone).toBeInstanceOf(HTMLElement)
    expect(clone.props).toEqual({ id: "box", className: "a b", "data-kind": "card", "aria-hidden": false, tabIndex: 2, draggable: false })
    expect(clone.style).toEqual({ width: 10, "--x": "1" })
    expect(clone.style).not.toBe(source.style)
    expect(clone.parentNode).toBeNull()
    expect(clone.ownerDocument).toBe(document)
  })

  it("leaves the children out of a shallow clone and copies them, in order, with a deep one", () => {
    const source = new FakeElement("div", { id: "outer" })
    const inner = new FakeElement("span", { "data-n": "1" })
    inner.style = { color: "red" } as StyleDesc
    const middle = new FakeText("middle")
    const last = new FakeElement("b")
    for (const child of [inner, middle, last]) source[DOM_BINDING]().insertBefore(child as unknown as Node, null)
    inner[DOM_BINDING]().insertBefore(new FakeText("deep") as unknown as Node, null)

    expect((source.cloneNode(false) as unknown as FakeElement).kids).toEqual([])
    expect((source.cloneNode() as unknown as FakeElement).kids).toEqual([])

    const clone = source.cloneNode(true) as unknown as FakeElement
    expect(clone.kids.length).toBe(3)
    const [innerClone, textClone, lastClone] = clone.kids as [FakeElement, FakeText, FakeElement]
    expect(innerClone).not.toBe(inner)
    expect(innerClone.type).toBe("span")
    expect(innerClone.props).toEqual({ "data-n": "1" })
    expect(innerClone.style).toEqual({ color: "red" })
    expect(innerClone.parent).toBe(clone)
    expect((innerClone.kids[0] as FakeText).text).toBe("deep")
    expect(textClone).toBeInstanceOf(Text)
    expect(textClone.text).toBe("middle")
    expect(lastClone.type).toBe("b")
    expect(clone.textContent).toBe("deepmiddle")
  })

  it("makes a clone of an svg element an SVGElement", () => {
    const path = new FakeSvgElement("path", { d: "M0 0", viewBox: "0 0 1 1" })
    const clone = path.cloneNode(true) as unknown as FakeSvgElement
    expect(clone).toBeInstanceOf(SVGElement)
    expect(clone.props).toEqual({ d: "M0 0", viewBox: "0 0 1 1" })
  })

  it("clones a text node by its data", () => {
    const text = new FakeText("hello")
    const clone = text.cloneNode() as unknown as FakeText
    expect(clone).not.toBe(text)
    expect(clone.data).toBe("hello")
    expect(clone.parentNode).toBeNull()
  })

  it("does not clone a document", () => {
    expect(document).toBeInstanceOf(Document)
    expect(() => document.cloneNode(true)).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
  })
})
