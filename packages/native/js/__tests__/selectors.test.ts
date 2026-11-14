import { describe, expect, it } from "vitest"
import { DOM_BINDING, DocumentFragment, HTMLElement, SVGElement, Text, type Element, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { document, installElementSource } from "../events/window-target.js"
import { mountedRenderers } from "../mounted-renderer.js"
import type { NativeRenderer } from "../host.js"
import { defineDomMembers } from "../dom-members.js"
import "../dom-globals.js"

type Props = Record<string, unknown>

/** Which element each state pseudo-class answers for, as the native renderer would. */
const states = { focus: new Set<number>(), focusVisible: new Set<number>(), focusWithin: new Set<number>(), hover: new Set<number>(), active: new Set<number>() }
const asked: string[] = []

/** The props of each element by id: the state of a checkbox the renderer reports. */
const propsById = new Map<number, Props>()

const renderer = {
  getInputChoice(id: number) {
    const props = propsById.get(id) ?? {}
    return { kind: props.type, checked: props.checked === true, defaultChecked: false, indeterminate: props.indeterminate === true, value: "" }
  },
  matchesFocus(id: number, selector: string): boolean {
    asked.push(selector)
    switch (selector) {
      case ":focus":
        return states.focus.has(id)
      case ":focus-visible":
        return states.focusVisible.has(id)
      case ":focus-within":
        return states.focusWithin.has(id)
      case ":hover":
        return states.hover.has(id)
      case ":active":
        return states.active.has(id)
      default:
        throw new Error(`matches() supports only the state selectors, got \`${selector}\``)
    }
  },
} as unknown as NativeRenderer

let nextId = 1

class FakeHtml extends HTMLElement {
  parent: Node | null = null
  readonly kids: Array<FakeHtml | FakeSvg | FakeText> = []
  mounted = true
  readonly nativeId = nextId++
  constructor(
    readonly type: string,
    readonly props: Props = {}
  ) {
    super()
    propsById.set(this.nativeId, props)
  }
  [DOM_BINDING](): ElementBinding {
    return elementBinding(this)
  }
}

class FakeSvg extends SVGElement {
  parent: Node | null = null
  readonly kids: Array<FakeHtml | FakeSvg | FakeText> = []
  mounted = true
  readonly nativeId = nextId++
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
  parent: Node | null = null
  constructor(public text: string) {
    super()
  }
  [DOM_BINDING](): TextBinding {
    return { parent: this.parent, children: [], connected: true, root: null, data: this.text }
  }
}

function elementBinding(element: FakeHtml | FakeSvg): ElementBinding {
  return {
    parent: element.parent,
    children: element.kids as readonly Node[],
    connected: true,
    root: null,
    type: element.type,
    prop: (name) => element.props[name],
    propNames: () => Object.keys(element.props),
    native: element.mounted ? { renderer, id: element.nativeId } : undefined,
  }
}

for (const prototype of [FakeHtml.prototype, FakeSvg.prototype]) {
  defineDomMembers(prototype, (element: FakeHtml | FakeSvg) => ({
    listeners: undefined as never,
    style: {},
    connected: true,
    prop: (name) => element.props[name],
    propNames: () => Object.keys(element.props),
  }))
}

function el(type: string, props: Props = {}, ...children: Array<FakeHtml | FakeSvg | FakeText | string>): FakeHtml {
  const element = new FakeHtml(type, props)
  adopt(element, children)
  return element
}

function adopt(parent: FakeHtml | FakeSvg, children: Array<FakeHtml | FakeSvg | FakeText | string>): void {
  for (const child of children) {
    const node = typeof child === "string" ? new FakeText(child) : child
    node.parent = parent
    parent.kids.push(node)
  }
}

const ids = (list: Iterable<Element>) => [...list].map((element) => element.id)

/**
 * <div id=root>
 *   <header id=head class="bar top"><a id=link href="/x">x</a></header>
 *   <main id=main>
 *     <section id=s1 class="box"><p id=p1 class="box inner">a</p><p id=p2>b</p></section>
 *     <section id=s2><p id=p3 class="inner">c</p></section>
 *   </main>
 *   <footer id=foot data-kind="Footer-x"></footer>
 * </div>
 */
function page() {
  const link = el("a", { id: "link", href: "/x" }, "x")
  const head = el("header", { id: "head", className: "bar top" }, link)
  const p1 = el("p", { id: "p1", className: "box inner" }, "a")
  const p2 = el("p", { id: "p2" }, "b")
  const s1 = el("section", { id: "s1", className: "box" }, p1, p2)
  const p3 = el("p", { id: "p3", className: "inner" }, "c")
  const s2 = el("section", { id: "s2" }, p3)
  const main = el("main", { id: "main" }, s1, s2)
  const foot = el("footer", { id: "foot", "data-kind": "Footer-x" })
  const root = el("div", { id: "root" }, head, main, foot)
  return { root, head, link, main, s1, s2, p1, p2, p3, foot }
}

describe("querySelectorAll", () => {
  it("matches a tag, a class, an id and the universal selector, in document order", () => {
    const t = page()
    expect(ids(t.root.querySelectorAll("p"))).toEqual(["p1", "p2", "p3"])
    expect(ids(t.root.querySelectorAll(".inner"))).toEqual(["p1", "p3"])
    expect(ids(t.root.querySelectorAll("#s2"))).toEqual(["s2"])
    expect(ids(t.root.querySelectorAll("*"))).toEqual(["head", "link", "main", "s1", "p1", "p2", "s2", "p3", "foot"])
  })

  it("lists a selector group in document order, once per element", () => {
    const t = page()
    expect(ids(t.root.querySelectorAll("footer, p.inner, p, header"))).toEqual(["head", "p1", "p2", "p3", "foot"])
  })

  it("compares tag names without case", () => {
    const t = page()
    expect(ids(t.root.querySelectorAll("P"))).toEqual(["p1", "p2", "p3"])
    expect(t.p1.matches("P.box")).toBe(true)
    expect(t.p1.localName).toBe("p")
    expect(t.p1.tagName).toBe("P")
  })

  it("covers the attribute operators", () => {
    const t = page()
    expect(ids(t.root.querySelectorAll("[href]"))).toEqual(["link"])
    expect(ids(t.root.querySelectorAll("[href='/x']"))).toEqual(["link"])
    expect(ids(t.root.querySelectorAll("[data-kind=Footer-x]"))).toEqual(["foot"])
    expect(ids(t.root.querySelectorAll("[class~=top]"))).toEqual(["head"])
    expect(ids(t.root.querySelectorAll("[data-kind|=Footer]"))).toEqual(["foot"])
    expect(ids(t.root.querySelectorAll("[id^=s]"))).toEqual(["s1", "s2"])
    expect(ids(t.root.querySelectorAll("[id$='1']"))).toEqual(["s1", "p1"])
    expect(ids(t.root.querySelectorAll("[id*=oo]"))).toEqual(["foot"])
    expect(ids(t.root.querySelectorAll("[data-kind='footer-X' i]"))).toEqual(["foot"])
    expect(ids(t.root.querySelectorAll("[data-kind='footer-X']"))).toEqual([])
  })

  it("covers the combinators", () => {
    const t = page()
    expect(ids(t.root.querySelectorAll("main p"))).toEqual(["p1", "p2", "p3"])
    expect(ids(t.root.querySelectorAll("main > p"))).toEqual([])
    expect(ids(t.root.querySelectorAll("section > p"))).toEqual(["p1", "p2", "p3"])
    expect(ids(t.root.querySelectorAll("header + main"))).toEqual(["main"])
    expect(ids(t.root.querySelectorAll("header ~ footer"))).toEqual(["foot"])
    expect(ids(t.root.querySelectorAll("p + p"))).toEqual(["p2"])
  })

  it("covers :not, :is, :where, :has, and the child pseudo-classes", () => {
    const t = page()
    expect(ids(t.root.querySelectorAll("p:not(.box)"))).toEqual(["p2", "p3"])
    expect(ids(t.root.querySelectorAll("p:not(.box, .inner)"))).toEqual(["p2"])
    expect(ids(t.root.querySelectorAll(":is(header, footer)"))).toEqual(["head", "foot"])
    expect(ids(t.root.querySelectorAll(":where(#s1, #s2) > p:first-child"))).toEqual(["p1", "p3"])
    expect(ids(t.root.querySelectorAll("section:has(> p.box)"))).toEqual(["s1"])
    expect(ids(t.root.querySelectorAll("p:nth-child(2)"))).toEqual(["p2"])
    expect(ids(t.root.querySelectorAll("p:last-child"))).toEqual(["p2", "p3"])
    expect(ids(t.root.querySelectorAll("footer:empty"))).toEqual(["foot"])
  })

  it("matches a selector's ancestors outside the element it is called on", () => {
    const t = page()
    expect(ids(t.s1.querySelectorAll("main p"))).toEqual(["p1", "p2"])
    expect(ids(t.s1.querySelectorAll("div > main > section p.inner"))).toEqual(["p1"])
  })

  it("searches the descendants only, not the element itself", () => {
    const t = page()
    expect(ids(t.s1.querySelectorAll("section"))).toEqual([])
    expect(ids(t.s1.querySelectorAll("*"))).toEqual(["p1", "p2"])
  })

  it("takes :scope as the element it is called on", () => {
    const t = page()
    expect(ids(t.main.querySelectorAll(":scope > section"))).toEqual(["s1", "s2"])
    expect(ids(t.main.querySelectorAll(":scope > p"))).toEqual([])
    expect(ids(t.main.querySelectorAll(":scope p.box"))).toEqual(["p1"])
    expect(ids(t.main.querySelectorAll("section:not(:scope)"))).toEqual(["s1", "s2"])
    expect(ids(t.main.querySelectorAll(":scope + footer"))).toEqual([])
  })

  it("throws a SyntaxError for a relative selector and for garbage", () => {
    const t = page()
    for (const garbage of ["", "   ", "> p", "p >", "[", "p:", "::before", "#", "a:nope", ":focus(x)", "p, ", "((", "div[", ":not()"]) {
      expect(() => t.root.querySelectorAll(garbage), garbage).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    }
    expect(() => t.root.querySelector("p >")).toThrow(/Failed to execute 'querySelector' on 'Element': 'p >' is not a valid selector/)
    expect(() => t.root.matches("[")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    expect(() => t.root.closest("[")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    expect(() => t.root.querySelectorAll("[")).toThrow(DOMException)
  })

  it("returns a static list that is not changed by the tree and answers item, length and forEach", () => {
    const t = page()
    const list = t.root.querySelectorAll("p")
    expect(list.length).toBe(3)
    expect(list.item(0)).toBe(t.p1)
    expect(list.item(3)).toBeNull()
    expect(list[2]).toBe(t.p3)
    const seen: string[] = []
    list.forEach((element, index) => seen.push(`${index}:${element.id}`))
    expect(seen).toEqual(["0:p1", "1:p2", "2:p3"])
    t.s1.kids.length = 0
    expect(list.length).toBe(3)
    expect(t.root.querySelectorAll("p").length).toBe(1)
    expect(Array.from(list).map((element) => element.id)).toEqual(["p1", "p2", "p3"])
    expect(list.map((element) => element.id)).toEqual(["p1", "p2", "p3"])
  })

  it("sees a tree the adapter changed since the last query with the same selector", () => {
    const t = page()
    expect(t.root.querySelectorAll("section:has(> p.box)").length).toBe(1)
    adopt(t.s2, [el("p", { id: "p4", className: "box" })])
    expect(ids(t.root.querySelectorAll("section:has(> p.box)"))).toEqual(["s1", "s2"])
    expect(ids(t.root.querySelectorAll("main p.box ~ p"))).toEqual(["p2"])
  })

  it("skips text nodes and reads an svg element's name and attributes", () => {
    const root = el("div", {}, "text")
    const svg = new FakeSvg("svg", { viewBox: "0 0 1 1" })
    const gradient = new FakeSvg("linearGradient", { id: "g" })
    adopt(svg, [gradient])
    adopt(root, [svg])
    expect(root.querySelectorAll("svg > lineargradient").length).toBe(1)
    expect(root.querySelectorAll("[viewBox]").length).toBe(1)
    expect(root.querySelectorAll("[viewbox]").length).toBe(1)
    expect(root.querySelectorAll("[viewBox='0 0 1 1']").length).toBe(1)
    expect(root.querySelectorAll("#g").length).toBe(1)
  })
})

describe("querySelector", () => {
  it("is the first of querySelectorAll, or null", () => {
    const t = page()
    expect(t.root.querySelector("p")).toBe(t.p1)
    expect(t.root.querySelector(".inner:not(.box)")).toBe(t.p3)
    expect(t.root.querySelector("table")).toBeNull()
    expect(t.main.querySelector(":scope > section")).toBe(t.s1)
  })
})

describe("matches", () => {
  it("answers for the element itself", () => {
    const t = page()
    expect(t.p1.matches("p.box")).toBe(true)
    expect(t.p1.matches(".box > p")).toBe(true)
    expect(t.p1.matches(".inner > p")).toBe(false)
    expect(t.p1.matches("section > p")).toBe(true)
    expect(t.p1.matches("#root p")).toBe(true)
    expect(t.p1.matches("p:not(.box)")).toBe(false)
  })

  it("takes :scope as the element itself", () => {
    const t = page()
    expect(t.p1.matches(":scope")).toBe(true)
    expect(t.p1.matches(":scope.box")).toBe(true)
    expect(t.p2.matches(":scope.box")).toBe(false)
    expect(t.p2.matches("p:not(:scope)")).toBe(false)
  })

  it("takes :root as an element whose parent is not an element", () => {
    const t = page()
    expect(t.root.matches(":root")).toBe(true)
    expect(t.p1.matches(":root")).toBe(false)
  })
})

describe("closest", () => {
  it("is the element itself when it matches, else the nearest ancestor", () => {
    const t = page()
    expect(t.p1.closest("p")).toBe(t.p1)
    expect(t.p1.closest(".box")).toBe(t.p1)
    expect(t.p2.closest(".box")).toBe(t.s1)
    expect(t.p3.closest("section")).toBe(t.s2)
    expect(t.p3.closest("div")).toBe(t.root)
    expect(t.p3.closest("table")).toBeNull()
    expect(t.p3.closest("main, section")).toBe(t.s2)
  })

  it("takes :scope as the element it is called on", () => {
    const t = page()
    expect(t.p2.closest(":scope")).toBe(t.p2)
    expect(t.p2.closest("section:has(:scope)")).toBe(t.s1)
  })

  it("stops at the top of its tree", () => {
    const loose = el("div", { className: "x" }, el("span"))
    expect(loose.firstElementChild!.closest(".x")).toBe(loose)
    expect(loose.closest(".y")).toBeNull()
  })
})

describe("the attributes a selector reads", () => {
  it("matches :disabled and :enabled from the props, and :checked and :indeterminate from the state native reports", () => {
    const off = el("button", { id: "off", disabled: true })
    const on = el("button", { id: "on", disabled: false })
    const field = el("input", { id: "field", type: "text" })
    const box = el("input", { id: "box", type: "checkbox", checked: true })
    const unchecked = el("input", { id: "unchecked", type: "checkbox", checked: false })
    const root = el("div", {}, off, on, field, box, unchecked)
    expect(ids(root.querySelectorAll(":disabled"))).toEqual(["off"])
    expect(ids(root.querySelectorAll(":enabled"))).toEqual(["on", "field", "box", "unchecked"])
    expect(ids(root.querySelectorAll(":checked"))).toEqual(["box"])
    expect(ids(root.querySelectorAll(":indeterminate"))).toEqual([])
    box.props.indeterminate = true
    expect(ids(root.querySelectorAll(":indeterminate"))).toEqual(["box"])
    expect(ids(root.querySelectorAll("input:not([type='hidden'])"))).toEqual(["field", "box", "unchecked"])
  })

  it("reads tabIndex as the tabindex attribute and an id with any case of the name", () => {
    const root = el("div", {}, el("div", { id: "t", tabIndex: 0 }), el("div", { id: "n" }))
    expect(ids(root.querySelectorAll("[tabindex]"))).toEqual(["t"])
    expect(ids(root.querySelectorAll("[TABINDEX]"))).toEqual(["t"])
    expect(ids(root.querySelectorAll("[tabindex='0']"))).toEqual(["t"])
  })
})

/** What Base UI's focus trap, floating-ui's `tabbable` and Radix ask for, on every focus change. */
const TABBABLE =
  "input:not([type='hidden']):not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],button:not([disabled]),[tabindex],iframe,object,embed,area[href],audio[controls],video[controls],[contenteditable]:not([contenteditable='false'])"

describe("the tabbable selector", () => {
  it("finds the elements a focus trap can reach, in document order", () => {
    const dialog = el(
      "div",
      { id: "dialog" },
      el("button", { id: "close" }),
      el("input", { id: "hidden", type: "hidden" }),
      el("input", { id: "name", type: "text" }),
      el("input", { id: "locked", disabled: true }),
      el("select", { id: "choice" }),
      el("textarea", { id: "notes", disabled: true }),
      el("a", { id: "plain" }),
      el("a", { id: "link", href: "/" }),
      el("div", { id: "stop", tabIndex: -1 }),
      el("div", { id: "edit", contentEditable: "true" }),
      el("div", { id: "fixed", contentEditable: "false" }),
      el("audio", { id: "audio", controls: true }),
      el("video", { id: "video" }),
      el("area", { id: "area", href: "#" }),
      el("iframe", { id: "frame" })
    )
    expect(ids(dialog.querySelectorAll(TABBABLE))).toEqual(["close", "name", "choice", "link", "stop", "edit", "audio", "area", "frame"])
  })

  it("is parsed once", () => {
    const dialog = el("div", {}, el("button", { id: "ok" }))
    for (let round = 0; round < 3; round += 1) expect(ids(dialog.querySelectorAll(TABBABLE))).toEqual(["ok"])
  })
})

describe("the state pseudo-classes", () => {
  it("ask the native renderer about the element, for exactly the pseudo-class written", () => {
    const t = page()
    asked.length = 0
    expect(t.p1.matches(":focus")).toBe(false)
    states.focus.add(t.p1.nativeId)
    expect(t.p1.matches(":focus")).toBe(true)
    expect(t.p2.matches(":focus")).toBe(false)
    states.focus.delete(t.p1.nativeId)
    states.focusVisible.add(t.p2.nativeId)
    states.focusWithin.add(t.s1.nativeId)
    states.hover.add(t.p3.nativeId)
    states.active.add(t.link.nativeId)
    expect(t.p2.matches(":focus-visible")).toBe(true)
    expect(t.p1.matches(":focus-visible")).toBe(false)
    expect(t.s1.matches(":focus-within")).toBe(true)
    expect(t.s2.matches(":focus-within")).toBe(false)
    expect(t.p3.matches(":hover")).toBe(true)
    expect(t.link.matches(":active")).toBe(true)
    expect(t.link.matches(":hover")).toBe(false)
    expect(new Set(asked)).toEqual(new Set([":focus", ":focus-visible", ":focus-within", ":hover", ":active"]))
    for (const set of Object.values(states)) set.clear()
  })

  it("combine with the rest of a selector and with the combinators", () => {
    const t = page()
    states.focus.add(t.p2.nativeId)
    states.focusWithin.add(t.s1.nativeId)
    expect(ids(t.root.querySelectorAll("p:focus"))).toEqual(["p2"])
    expect(ids(t.root.querySelectorAll(":focus-within > p"))).toEqual(["p1", "p2"])
    expect(ids(t.root.querySelectorAll("p:not(:focus)"))).toEqual(["p1", "p3"])
    expect(ids(t.root.querySelectorAll("p.box:focus, a"))).toEqual(["link"])
    expect(t.p2.closest(":focus-within")).toBe(t.s1)
    for (const set of Object.values(states)) set.clear()
  })

  it("do not ask native for a selector that has none of them", () => {
    const t = page()
    asked.length = 0
    t.root.querySelectorAll("section p:not(.box)")
    t.p1.matches("p.box")
    expect(asked).toEqual([])
  })

  it("never match an element that is not mounted, and never reach native for it", () => {
    const t = page()
    t.p1.mounted = false
    states.focus.add(t.p1.nativeId)
    asked.length = 0
    expect(t.p1.matches(":focus")).toBe(false)
    expect(asked).toEqual([])
    states.focus.clear()
  })

  it("keep :visited and :link as the DOM has them for a page that was never visited", () => {
    const t = page()
    expect(t.link.matches(":visited")).toBe(false)
  })
})

describe("document and fragment queries", () => {
  function mountWindow() {
    const native = {} as NativeRenderer
    const html = new FakeHtml("html", { id: "html" })
    const head = new FakeHtml("head", { id: "head-el" })
    const body = new FakeHtml("body", { id: "body-el" })
    html.parent = document
    adopt(html, [head, body])
    const remove = installElementSource(native, () => undefined, () => ({ html, head, body }))
    mountedRenderers().push(native)
    return {
      html,
      body,
      unmount() {
        mountedRenderers().splice(mountedRenderers().indexOf(native), 1)
        remove()
      },
    }
  }

  it("lets document find an element in the app and one placed into body, in document order", () => {
    const window = mountWindow()
    const app = el("div", { id: "app", className: "layer" }, el("button", { id: "inside" }))
    const portal = el("div", { id: "portal", className: "layer" }, el("button", { id: "floating" }))
    adopt(window.body, [app, portal])
    expect(document.querySelector("#inside")).toBe(app.firstElementChild)
    expect(document.querySelector("#floating")).toBe(portal.firstElementChild)
    expect(ids(document.querySelectorAll(".layer"))).toEqual(["app", "portal"])
    expect(ids(document.querySelectorAll("body > .layer button"))).toEqual(["inside", "floating"])
    expect(document.querySelector("#nothing")).toBeNull()
    expect(document.querySelector(":root")).toBe(window.html)
    expect(document.querySelector(":scope")).toBe(window.html)
    window.unmount()
  })

  it("finds only the stand-in html, head and body while no window is mounted", () => {
    expect(document.querySelector("div")).toBeNull()
    expect(Array.from(document.querySelectorAll("*")).map((element) => element.localName)).toEqual(["html", "head", "body"])
  })

  it("the stand-in html, head and body have no type property, as a browser's have none", () => {
    for (const element of [document.documentElement, document.head, document.body]) {
      expect((element as { type?: unknown }).type).toBeUndefined()
    }
    expect(document.body.localName).toBe("body")
  })

  it("throws a SyntaxError that names the document", () => {
    expect(() => document.querySelector("[")).toThrow(/Failed to execute 'querySelector' on 'Document'/)
    expect(() => document.querySelectorAll("a:b:")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
  })

  it("is on DocumentFragment too", () => {
    const query = DocumentFragment.prototype.querySelectorAll
    const fragment = Object.create(DocumentFragment.prototype, {
      [DOM_BINDING]: {
        value: () => ({ parent: null, children: [el("span", { id: "s" })], connected: false, root: null }),
      },
    }) as DocumentFragment
    expect(typeof query).toBe("function")
    expect(ids(fragment.querySelectorAll("span"))).toEqual(["s"])
    expect(fragment.querySelector("span")?.id).toBe("s")
  })
})

describe("the cost of the tabbable selector", () => {
  it("queries a 1000-element tree", () => {
    const rows: FakeHtml[] = []
    for (let index = 0; index < 250; index += 1) {
      rows.push(
        el(
          "div",
          { className: "row" },
          el("button", { disabled: index % 5 === 0 }),
          el("input", { type: index % 7 === 0 ? "hidden" : "text" }),
          el("a", index % 2 === 0 ? { href: "/" } : {})
        )
      )
    }
    const root = el("div", {}, ...rows)
    expect(root.querySelectorAll("*").length).toBe(1000)
    root.querySelectorAll(TABBABLE)
    const rounds = 50
    const start = performance.now()
    let count = 0
    for (let round = 0; round < rounds; round += 1) count = root.querySelectorAll(TABBABLE).length
    const each = (performance.now() - start) / rounds
    console.log(`querySelectorAll(tabbable) over 1000 elements: ${each.toFixed(3)} ms (${count} found)`)
    expect(count).toBeGreaterThan(0)
  })
})
