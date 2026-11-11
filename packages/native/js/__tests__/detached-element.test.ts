import { describe, expect, it } from "vitest"
import { HTMLElement, SVGElement } from "../dom/nodes.js"
import { HTMLInputElement, HTMLTextAreaElement } from "../dom/html-element-classes.js"
import { document } from "../events/window-target.js"
import { getComputedStyle } from "../computed-style.js"
import "../dom-globals.js"

describe("document.createElement", () => {
  it("makes an HTML element in no tree", () => {
    const element = document.createElement("DIV")
    expect(element).toBeInstanceOf(HTMLElement)
    expect(element).not.toBeInstanceOf(SVGElement)
    expect(element.tagName).toBe("DIV")
    expect(element.localName).toBe("div")
    expect(element.isConnected).toBe(false)
    expect(element.parentNode).toBeNull()
    expect(element.parentElement).toBeNull()
    expect(element.childNodes).toEqual([])
    expect(element.ownerDocument).toBe(document)
    expect(element.getRootNode()).toBe(element)
    expect(document.contains(element)).toBe(false)
  })

  it("is a different element each time", () => {
    expect(document.createElement("div")).not.toBe(document.createElement("div"))
  })

  it("rejects a name that is not one", () => {
    for (const name of ["", " div", "a b", "1div", "<div>", "a/b"]) {
      expect(() => document.createElement(name), name).toThrowError(expect.objectContaining({ name: "InvalidCharacterError" }))
    }
    expect(document.createElement("my-element").localName).toBe("my-element")
  })

  it("keeps attributes, which read back as the DOM's text", () => {
    const element = document.createElement("div")
    expect(element.getAttribute("role")).toBeNull()
    element.setAttribute("role", "dialog")
    element.setAttribute("data-row-id", "7")
    element.setAttribute("tabindex", "2")
    expect(element.getAttribute("role")).toBe("dialog")
    expect(element.hasAttribute("data-row-id")).toBe(true)
    expect(element.dataset).toEqual({ rowId: "7" })
    expect(element.getAttributeNames().sort()).toEqual(["data-row-id", "role", "tabindex"])
    element.removeAttribute("role")
    expect(element.getAttribute("role")).toBeNull()
    expect(element.toggleAttribute("inert")).toBe(true)
    expect(element.hasAttribute("inert")).toBe(true)
  })

  it("has a style declaration that reads what was written", () => {
    const element = document.createElement("div")
    element.style.width = "20px"
    element.style.setProperty("--x", "1")
    expect(element.style.width).toBe("20px")
    expect(element.getAttribute("style")).toBe("width: 20px; --x: 1;")
    element.style.cssText = ""
    expect(element.style.width).toBe("")
  })

  it("has listeners that dispatchEvent reaches", () => {
    const element = document.createElement("div")
    const heard: string[] = []
    element.addEventListener("ping", (event) => heard.push(event.type))
    expect(element.dispatchEvent(new Event("ping"))).toBe(true)
    expect(heard).toEqual(["ping"])
  })

  it("has no box: zero sizes, an empty list of rects, no offset parent", () => {
    const element = document.createElement("div")
    expect(element.offsetWidth).toBe(0)
    expect(element.offsetHeight).toBe(0)
    expect(element.offsetLeft).toBe(0)
    expect(element.offsetTop).toBe(0)
    expect(element.clientLeft).toBe(0)
    expect(element.offsetParent).toBeNull()
    expect(element.getClientRects().length).toBe(0)
    expect(element.getBoundingClientRect()).toEqual({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
    expect([element.scrollTop, element.scrollLeft, element.scrollWidth, element.scrollHeight, element.clientWidth, element.clientHeight]).toEqual([0, 0, 0, 0, 0, 0])
    expect(() => element.scrollTo(0, 10)).not.toThrow()
  })

  it("reads an empty computed style, as an element outside a document does", () => {
    const element = document.createElement("div")
    const style = getComputedStyle(element as never)
    expect(style.width).toBe("")
    expect(style.display).toBe("")
  })

  it("takes no focus, and reads preventScroll as the dictionary conversion does", () => {
    const element = document.createElement("div")
    let read = false
    element.focus({
      get preventScroll() {
        read = true
        return false
      },
    })
    expect(read).toBe(true)
    expect(document.activeElement).not.toBe(element)
    expect(() => element.blur()).not.toThrow()
  })

  it("has no native id, since nothing mounts it", () => {
    expect(() => (document.createElement("div") as unknown as { nativeId: number }).nativeId).toThrowError("no native id")
  })

  it("has no members that insert it", () => {
    const element = document.createElement("div") as unknown as Record<string, unknown>
    for (const name of ["appendChild", "append", "cloneNode", "insertBefore", "remove"]) expect(element[name], name).toBeUndefined()
  })
})

describe("HTMLInputElement and HTMLTextAreaElement", () => {
  it("are globals and tell an element by its tag", () => {
    expect(globalThis.HTMLInputElement).toBe(HTMLInputElement)
    expect(globalThis.HTMLTextAreaElement).toBe(HTMLTextAreaElement)
    const input = document.createElement("input")
    const area = document.createElement("textarea")
    const div = document.createElement("div")
    expect(input instanceof HTMLInputElement).toBe(true)
    expect(input instanceof HTMLTextAreaElement).toBe(false)
    expect(area instanceof HTMLTextAreaElement).toBe(true)
    expect(area instanceof HTMLInputElement).toBe(false)
    expect(div instanceof HTMLInputElement).toBe(false)
    expect(({ localName: "input" }) instanceof HTMLInputElement).toBe(false)
    expect(null instanceof HTMLInputElement).toBe(false)
    expect(input instanceof HTMLElement).toBe(true)
    expect(HTMLInputElement.name).toBe("HTMLInputElement")
  })

  it("cannot be constructed", () => {
    expect(() => new (HTMLInputElement as unknown as new () => object)()).toThrowError("Illegal constructor")
    expect(() => new (HTMLTextAreaElement as unknown as new () => object)()).toThrowError("Illegal constructor")
  })
})

describe("window.scrollX and scrollY", () => {
  it("are 0: the document cannot scroll", () => {
    expect(window.scrollX).toBe(0)
    expect(window.scrollY).toBe(0)
  })
})

describe("dataset", () => {
  it("is a live map of the data attributes, in camel case", () => {
    const element = document.createElement("div")
    element.setAttribute("data-row-id", "7")
    const map = element.dataset
    expect(map.rowId).toBe("7")
    expect(map.missing).toBeUndefined()
    expect("rowId" in map).toBe(true)
    expect("missing" in map).toBe(false)
    map.tabindex = "3"
    map.fooBar = "x"
    expect(element.getAttribute("data-tabindex")).toBe("3")
    expect(element.getAttribute("data-foo-bar")).toBe("x")
    expect(Object.keys(map).sort()).toEqual(["fooBar", "rowId", "tabindex"])
    expect({ ...map }).toEqual({ rowId: "7", tabindex: "3", fooBar: "x" })
    delete map.tabindex
    expect(element.hasAttribute("data-tabindex")).toBe(false)
    element.removeAttribute("data-row-id")
    expect(map.rowId).toBeUndefined()
    expect(element.dataset).toBe(map)
  })

  it("rejects a write to a name with a dash before a lowercase letter", () => {
    const map = document.createElement("div").dataset
    expect(() => {
      map["a-b"] = "x"
    }).toThrowError(expect.objectContaining({ name: "SyntaxError" }))
  })
})
