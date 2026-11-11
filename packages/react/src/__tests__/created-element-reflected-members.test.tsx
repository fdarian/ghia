/** The members of an element made by `document.createElement`: `hidden`, `tabIndex`, `isContentEditable`, `shadowRoot` and `assignedSlot`. */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
let testRoot: ReturnType<typeof createTestRoot>
beforeAll(() => {
  testRoot = createTestRoot()
  testRoot.render(<div />)
})
afterAll(() => testRoot.unmount())

const make = (tag: string, attributes: Record<string, string> = {}) => {
  const element = document.createElement(tag)
  for (const name of Object.keys(attributes)) element.setAttribute(name, attributes[name])
  return element
}

describeNative("hidden", () => {
  it("is the hidden attribute", () => {
    const element = make("div")
    expect(element.hidden).toBe(false)
    element.setAttribute("hidden", "")
    expect(element.hidden).toBe(true)
    element.removeAttribute("hidden")
    expect(element.hidden).toBe(false)
  })

  it("writes the attribute", () => {
    const element = make("div")
    element.hidden = true
    expect(element.getAttribute("hidden")).toBe("")
    element.hidden = false
    expect(element.hasAttribute("hidden")).toBe(false)
    element.hidden = "yes" as unknown as boolean
    expect(element.hidden).toBe(true)
    element.hidden = "" as unknown as boolean
    expect(element.hasAttribute("hidden")).toBe(false)
  })

  it("keeps until-found as that text, in any case", () => {
    const element = make("div")
    element.hidden = "until-found"
    expect(element.getAttribute("hidden")).toBe("until-found")
    expect(element.hidden).toBe("until-found")
    element.setAttribute("hidden", "UNTIL-FOUND")
    expect(element.hidden).toBe("until-found")
  })
})

describeNative("tabIndex", () => {
  it("is 0 for the tags the HTML standard says, and -1 for the rest", () => {
    for (const tag of ["a", "button", "input", "textarea"]) {
      expect(make(tag).tabIndex, tag).toBe(0)
    }
    for (const tag of ["div", "span", "li", "h1", "table", "svg", "label"]) expect(make(tag).tabIndex, tag).toBe(-1)
  })

  it("is 0 for the first summary of a details only", () => {
    expect(make("summary").tabIndex, "a summary in no details").toBe(-1)
  })

  it("is the attribute, parsed as the DOM does, over the default", () => {
    expect(make("div", { tabindex: "0" }).tabIndex).toBe(0)
    expect(make("button", { tabindex: "-1" }).tabIndex).toBe(-1)
    expect(make("div", { tabindex: " +3x" }).tabIndex).toBe(3)
    expect(make("button", { tabindex: "nope" }).tabIndex, "no integer falls back to the tag's default").toBe(0)
    expect(make("div", { tabindex: "99999999999" }).tabIndex, "out of the 32-bit range too").toBe(-1)
  })

  it("writes the attribute as an integer", () => {
    const element = make("div")
    element.tabIndex = 4.9
    expect(element.getAttribute("tabindex")).toBe("4")
    element.tabIndex = Number.NaN
    expect(element.getAttribute("tabindex")).toBe("0")
    element.tabIndex = -1
    expect(element.tabIndex).toBe(-1)
  })
})

describeNative("isContentEditable, shadowRoot and assignedSlot", () => {
  it("are what an element with no contenteditable and no shadow DOM has", () => {
    const element = make("div", { contenteditable: "true" })
    expect(element.isContentEditable, "Ghia has no contenteditable").toBe(false)
    expect(element.shadowRoot).toBeNull()
    expect(element.assignedSlot).toBeNull()
  })
})
