/**
 * What an element made by `document.createElement` has as an element of a real document:
 * `instanceof` by tag name, `dataset` and the `HTMLElement` globals. Members that need a mounted
 * root (a box, focus) are in dom-building.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("document.createElement members", () => {
  let testRoot: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    testRoot = createTestRoot()
    testRoot.render(<div />)
  })

  afterEach(() => {
    testRoot.unmount()
  })

  it("makes elements that are HTMLElement and of their tag's class where there is one", () => {
    const input = document.createElement("input")
    const area = document.createElement("textarea")
    const div = document.createElement("div")
    const button = document.createElement("button")
    expect(button instanceof HTMLButtonElement).toBe(true)
    expect(input instanceof HTMLButtonElement).toBe(false)
    expect(div instanceof HTMLButtonElement).toBe(false)
    expect(HTMLButtonElement.name).toBe("HTMLButtonElement")
    expect(() => new (HTMLButtonElement as unknown as new () => object)()).toThrowError("Illegal constructor")
    expect(input instanceof HTMLInputElement).toBe(true)
    expect(input instanceof HTMLTextAreaElement).toBe(false)
    expect(area instanceof HTMLTextAreaElement).toBe(true)
    expect(div instanceof HTMLInputElement).toBe(false)
    expect(input instanceof HTMLElement).toBe(true)
    expect(HTMLInputElement.name).toBe("HTMLInputElement")
    expect(() => new (HTMLInputElement as unknown as new () => object)()).toThrowError("Illegal constructor")
  })

  it("has a live dataset over the data attributes, in camel case", () => {
    const element = document.createElement("div")
    element.setAttribute("data-row-id", "7")
    const map = element.dataset
    expect(map.rowId).toBe("7")
    expect(map.missing).toBeUndefined()
    expect("rowId" in map).toBe(true)
    map.fooBar = "x"
    expect(element.getAttribute("data-foo-bar")).toBe("x")
    expect({ ...map }).toEqual({ rowId: "7", fooBar: "x" })
    delete map.fooBar
    expect(element.hasAttribute("data-foo-bar")).toBe(false)
    expect(element.dataset).toBe(map)
    expect(() => {
      map["a-b"] = "x"
    }).toThrowError(expect.objectContaining({ name: "SyntaxError" }))
  })

  it("keeps attributes with the DOM's text, and toggleAttribute", () => {
    const element = document.createElement("div")
    element.setAttribute("role", "dialog")
    element.setAttribute("tabindex", "2")
    expect(element.getAttribute("tabindex")).toBe("2")
    expect(element.getAttributeNames().sort()).toEqual(["role", "tabindex"])
    expect(element.toggleAttribute("inert")).toBe(true)
    element.removeAttribute("role")
    expect(element.getAttribute("role")).toBeNull()
  })
})
