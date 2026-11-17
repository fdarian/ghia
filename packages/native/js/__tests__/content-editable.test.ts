import { describe, expect, it } from "vitest"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { defineDomMembers } from "../dom-members.js"
import { editableState, editingHostOf, isContentEditable, isEditingHost } from "../editing/host.js"
import "../dom-globals.js"

type Props = Record<string, unknown>

class FakeElement extends HTMLElement {
  parent: Node | null = null
  readonly kids: Array<FakeElement | FakeText> = []
  constructor(
    readonly type: string,
    readonly props: Props = {}
  ) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    return {
      parent: this.parent,
      children: this.kids as readonly Node[],
      connected: true,
      root: null,
      type: this.type,
      prop: (name) => this.props[name],
      propNames: () => Object.keys(this.props),
      native: undefined,
    }
  }
}

class FakeText extends Text {
  parent: Node | null = null;
  [DOM_BINDING](): TextBinding {
    return { parent: this.parent, children: [], connected: true, root: null, data: "text" }
  }
}

defineDomMembers(FakeElement.prototype, (element: FakeElement) => ({
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

function el(type: string, props: Props = {}, ...children: Array<FakeElement | FakeText>): FakeElement {
  const element = new FakeElement(type, props)
  for (const child of children) {
    child.parent = element
    element.kids.push(child)
  }
  return element
}

describe("contentEditable", () => {
  it("reflects the attribute: true, false, plaintext-only, and inherit for anything else", () => {
    expect(el("div").contentEditable).toBe("inherit")
    expect(el("div", { contentEditable: true }).contentEditable).toBe("true")
    expect(el("div", { contentEditable: false }).contentEditable).toBe("false")
    expect(el("div", { contenteditable: "" }).contentEditable).toBe("true")
    expect(el("div", { contenteditable: "TRUE" }).contentEditable).toBe("true")
    expect(el("div", { contenteditable: "Plaintext-Only" }).contentEditable).toBe("plaintext-only")
    expect(el("div", { contenteditable: "maybe" }).contentEditable).toBe("inherit")
  })

  it("gives the attribute the text a framework's boolean prop has in the DOM", () => {
    expect(el("div", { contentEditable: true }).getAttribute("contenteditable")).toBe("true")
    expect(el("div", { contentEditable: false }).getAttribute("contenteditable")).toBe("false")
  })

  it("is written as a lowercased keyword, and inherit removes the attribute", () => {
    const box = el("div")
    box.contentEditable = "TRUE"
    expect(box.getAttribute("contenteditable")).toBe("true")
    box.contentEditable = "Plaintext-only"
    expect(box.getAttribute("contenteditable")).toBe("plaintext-only")
    box.contentEditable = "false"
    expect(box.contentEditable).toBe("false")
    box.contentEditable = "Inherit"
    expect(box.hasAttribute("contenteditable")).toBe(false)
    expect(box.contentEditable).toBe("inherit")
  })

  it("throws a SyntaxError for any other text and leaves the attribute alone", () => {
    const box = el("div", { contenteditable: "true" })
    for (const bad of ["", "yes", "events", null, undefined]) {
      expect(() => {
        box.contentEditable = bad as string
      }).toThrowError(expect.objectContaining({ name: "SyntaxError" }))
    }
    expect(box.getAttribute("contenteditable")).toBe("true")
  })

  it("is the attribute: setAttribute and removeAttribute move it", () => {
    const box = el("div")
    box.setAttribute("contenteditable", "")
    expect(box.contentEditable).toBe("true")
    box.removeAttribute("contenteditable")
    expect(box.contentEditable).toBe("inherit")
  })
})

describe("isContentEditable and editing hosts", () => {
  it("is inherited from the nearest ancestor with a value, and false without one", () => {
    const text = new FakeText()
    const inner = el("span", {}, text)
    const island = el("div", { contentEditable: "false" }, inner)
    const nested = el("div", { contentEditable: "plaintext-only" })
    island.kids.push(nested)
    nested.parent = island
    const host = el("div", { contentEditable: true }, el("p"), island)
    const outside = el("div")
    expect(isContentEditable(host)).toBe(true)
    expect(isContentEditable(host.kids[0] as FakeElement)).toBe(true)
    expect(isContentEditable(island)).toBe(false)
    expect(isContentEditable(inner)).toBe(false)
    expect(isContentEditable(nested)).toBe(true)
    expect(isContentEditable(outside)).toBe(false)
    expect(host.isContentEditable).toBe(true)
    expect(inner.isContentEditable).toBe(false)
    expect(editableState(text)).toBe("false")
  })

  it("finds the outermost editable ancestor whose parent is not editable", () => {
    const text = new FakeText()
    const leaf = el("span", {}, text)
    const innerHost = el("div", { contentEditable: "true" }, leaf)
    const island = el("div", { contentEditable: "false" }, innerHost)
    const outerHost = el("div", { contentEditable: "true" }, island)
    const nested = el("div", { contentEditable: "true" })
    const inside = el("p", {}, nested)
    outerHost.kids.push(inside)
    inside.parent = outerHost
    nested.parent = inside

    expect(editingHostOf(outerHost)).toBe(outerHost)
    expect(editingHostOf(island)).toBeNull()
    expect(editingHostOf(innerHost)).toBe(innerHost)
    expect(editingHostOf(text)).toBe(innerHost)
    expect(editingHostOf(nested)).toBe(outerHost)
    expect(isEditingHost(outerHost)).toBe(true)
    expect(isEditingHost(innerHost)).toBe(true)
    expect(isEditingHost(nested)).toBe(false)
    expect(isEditingHost(leaf)).toBe(false)
  })
})

describe("tabIndex of an editing host", () => {
  it("is 0 for a host and -1 for what is inside it, unless it has a tabindex", () => {
    const inner = el("span")
    const host = el("div", { contentEditable: true }, inner)
    expect(host.tabIndex).toBe(0)
    expect(inner.tabIndex).toBe(-1)
    expect(el("div", { contentEditable: false }).tabIndex).toBe(-1)
    host.tabIndex = -1
    expect(host.tabIndex).toBe(-1)
  })
})
