import { describe, expect, it } from "vitest"
import {
  attributeNameOf,
  attributesOfProps,
  attributesWritten,
  inputAttributeValue,
  inputDefaultProp,
  isStoredAttribute,
  propOfJsxAttribute,
  propWrittenBy,
} from "../dom/attribute-names.js"

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

describe("propOfJsxAttribute", () => {
  it("names the prop of a web JSX attribute and converts its value as the DOM would", () => {
    expect(propOfJsxAttribute("for", "x")).toEqual({ prop: "htmlFor", value: "x" })
    expect(propOfJsxAttribute("tabindex", 0)).toEqual({ prop: "tabIndex", value: 0 })
    expect(propOfJsxAttribute("tabindex", " -1 ")).toEqual({ prop: "tabIndex", value: -1 })
    expect(propOfJsxAttribute("tabindex", "abc")).toEqual({ prop: "tabIndex", value: "abc" })
    expect(propOfJsxAttribute("colspan", "2")).toEqual({ prop: "colSpan", value: 2 })
    expect(propOfJsxAttribute("rowspan", 3)).toEqual({ prop: "rowSpan", value: 3 })
    expect(propOfJsxAttribute("maxlength", "4")).toEqual({ prop: "maxLength", value: 4 })
  })

  it("gives a presence attribute its truthiness", () => {
    expect(propOfJsxAttribute("autofocus", true)).toEqual({ prop: "autoFocus", value: true })
    expect(propOfJsxAttribute("autofocus", "")).toEqual({ prop: "autoFocus", value: false })
    expect(propOfJsxAttribute("readonly", "false")).toEqual({ prop: "readOnly", value: true })
    expect(propOfJsxAttribute("readonly", false)).toEqual({ prop: "readOnly", value: false })
  })

  it("keeps null and undefined, the removal", () => {
    expect(propOfJsxAttribute("autofocus", undefined)).toEqual({ prop: "autoFocus", value: undefined })
    expect(propOfJsxAttribute("tabindex", null)).toEqual({ prop: "tabIndex", value: null })
  })

  it("passes every other name through", () => {
    for (const name of ["class", "className", "tabIndex", "autoFocus", "disabled", "span", "hidden", "draggable", "data-x"]) {
      expect(propOfJsxAttribute(name, "1")).toEqual({ prop: name, value: "1" })
    }
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

describe("what answers the checked and value attributes of an input", () => {
  const props = (entries: Record<string, unknown>) => (name: string) => entries[name]

  it("is the default prop, and the checked or value prop only where there is no default", () => {
    expect(inputAttributeValue("checked", props({ checked: false, defaultChecked: true }), "checkbox")).toBe(true)
    expect(inputAttributeValue("checked", props({ checked: true }), "checkbox")).toBe(true)
    expect(inputAttributeValue("value", props({ value: "x", defaultValue: "y" }), "text")).toBe("y")
    expect(inputAttributeValue("value", props({ value: "x" }), "text")).toBe("x")
    expect(inputAttributeValue("value", props({ value: "x", defaultValue: "y" }), "checkbox")).toBe("x")
    expect(inputAttributeValue("value", props({ defaultValue: "y" }), "hidden")).toBe("y")
  })

  it("is the same answer in the attribute store, whatever order the props come in", () => {
    for (const entries of [
      [["checked", false], ["defaultChecked", true]],
      [["defaultChecked", true], ["checked", false]],
    ] as const) {
      expect(attributesOfProps(entries, "input").get("checked")).toBe("")
    }
    expect(attributesOfProps([["checked", true], ["defaultChecked", false]], "input").has("checked")).toBe(false)
    expect(attributesOfProps([["value", "x"], ["defaultValue", "y"], ["type", "text"]], "input").get("value")).toBe("y")
    expect(attributesOfProps([["type", "checkbox"], ["value", "x"], ["defaultValue", "y"]], "input").get("value")).toBe("x")
    expect(attributesOfProps([["value", "x"], ["defaultValue", "y"]], "textarea").get("value")).toBe("x")
  })

  it("is re-sent for the value attribute when the type of an input changes", () => {
    const current: Record<string, unknown> = { value: "x", defaultValue: "y", type: "checkbox" }
    expect(attributesWritten("input", "type", "checkbox", props(current))).toEqual([["type", "checkbox"], ["value", "x"]])
    current.type = "text"
    expect(attributesWritten("input", "type", "text", props(current))).toEqual([["type", "text"], ["value", "y"]])
    expect(attributesWritten("div", "tabIndex", 1, props({}))).toEqual([["tabindex", "1"]])
  })
})
