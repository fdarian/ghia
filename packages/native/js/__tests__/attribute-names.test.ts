import { describe, expect, it } from "vitest"
import { attributeNameOf, inputDefaultProp, isStoredAttribute, propWrittenBy } from "../dom/attribute-names.js"

describe("propWrittenBy", () => {
  it("names the prop and converts the text as the browser's reflection does", () => {
    expect(propWrittenBy("tabindex", "-1", undefined)).toEqual({ prop: "tabIndex", value: -1 })
    expect(propWrittenBy("tabindex", "abc", undefined)).toEqual({ prop: "tabIndex", value: "abc" })
    expect(propWrittenBy("inert", "", undefined)).toEqual({ prop: "inert", value: true })
    expect(propWrittenBy("disabled", "false", undefined)).toEqual({ prop: "disabled", value: true })
    expect(propWrittenBy("draggable", "true", undefined)).toEqual({ prop: "draggable", value: true })
    expect(propWrittenBy("draggable", "false", undefined)).toEqual({ prop: "draggable", value: false })
    expect(propWrittenBy("class", "a", undefined)).toEqual({ prop: "className", value: "a" })
    expect(propWrittenBy("for", "x", undefined)).toEqual({ prop: "htmlFor", value: "x" })
    expect(propWrittenBy("aria-hidden", "true", undefined)).toEqual({ prop: "aria-hidden", value: "true" })
    expect(propWrittenBy("data-x", "1", undefined)).toEqual({ prop: "data-x", value: "1" })
  })

  it("keeps the key the element already has, and unsets on null", () => {
    expect(propWrittenBy("class", "a", "class")).toEqual({ prop: "class", value: "a" })
    expect(propWrittenBy("tabindex", null, "tabIndex")).toEqual({ prop: "tabIndex", value: undefined })
  })

  it("stores on* and the non-attribute props without a prop", () => {
    for (const name of ["onclick", "children", "key", "ref"]) expect(isStoredAttribute(name)).toBe(true)
    expect(isStoredAttribute("tabindex")).toBe(false)
  })
})

describe("the checked and value attributes of an input", () => {
  it("are defaults, except where the attribute is the value itself", () => {
    expect(inputDefaultProp("checked", "checkbox")).toBe("defaultChecked")
    expect(inputDefaultProp("value", undefined)).toBe("defaultValue")
    expect(inputDefaultProp("value", "text")).toBe("defaultValue")
    expect(inputDefaultProp("value", "range")).toBe("defaultValue")
    for (const type of ["checkbox", "RADIO", "hidden", "submit", "button", "reset", "image"]) {
      expect(inputDefaultProp("value", type)).toBeUndefined()
    }
    expect(inputDefaultProp("name", "text")).toBeUndefined()
  })

  it("are named by the default props", () => {
    expect(attributeNameOf("defaultChecked", false)).toBe("checked")
    expect(attributeNameOf("defaultValue", false)).toBe("value")
    expect(attributeNameOf("defaultValue", true)).toBe("defaultValue")
  })
})
