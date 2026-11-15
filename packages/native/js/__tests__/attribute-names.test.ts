import { describe, expect, it } from "vitest"
import {
  attributeNameOf,
  attributeText,
  attributesOfProps,
  attributesWritten,
  inputAttributeValue,
  inputDefaultProp,
  isStoredAttribute,
  jsxAttributeOf,
  jsxAttributeValue,
  nativeValueOfText,
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

function jsxWritten(name: string, value: unknown): { prop: string; value: unknown } {
  const attribute = jsxAttributeOf(name)
  if (attribute === undefined) return { prop: name, value }
  return { prop: attribute.prop, value: jsxAttributeValue(attribute, value) }
}

describe("jsxAttributeOf and jsxAttributeValue", () => {
  it("name the prop of a web JSX attribute and convert its value as the DOM would", () => {
    expect(jsxWritten("for", "x")).toEqual({ prop: "htmlFor", value: "x" })
    expect(jsxWritten("tabindex", 0)).toEqual({ prop: "tabIndex", value: 0 })
    expect(jsxWritten("tabindex", " -1 ")).toEqual({ prop: "tabIndex", value: -1 })
    expect(jsxWritten("tabindex", "abc")).toEqual({ prop: "tabIndex", value: "abc" })
    expect(jsxWritten("colspan", "2")).toEqual({ prop: "colSpan", value: 2 })
    expect(jsxWritten("rowspan", 3)).toEqual({ prop: "rowSpan", value: 3 })
    expect(jsxWritten("maxlength", "4")).toEqual({ prop: "maxLength", value: 4 })
  })

  it("make a presence attribute on for any string, as a template does, and keep a boolean", () => {
    expect(jsxWritten("autofocus", true)).toEqual({ prop: "autoFocus", value: true })
    expect(jsxWritten("autofocus", "")).toEqual({ prop: "autoFocus", value: true })
    expect(jsxWritten("readonly", "false")).toEqual({ prop: "readOnly", value: true })
    expect(jsxWritten("readonly", false)).toEqual({ prop: "readOnly", value: false })
  })

  it("keep null and undefined, the removal", () => {
    expect(jsxWritten("autofocus", undefined)).toEqual({ prop: "autoFocus", value: undefined })
    expect(jsxWritten("tabindex", null)).toEqual({ prop: "tabIndex", value: null })
  })

  it("find nothing for every other name", () => {
    for (const name of ["class", "className", "tabIndex", "autoFocus", "disabled", "span", "hidden", "draggable", "data-x"]) {
      expect(jsxAttributeOf(name)).toBeUndefined()
    }
  })
})

describe("nativeValueOfText", () => {
  it("gives native an integer for a number prop and a boolean for draggable, as setAttribute does", () => {
    expect(nativeValueOfText("tabIndex", "0")).toBe(0)
    expect(nativeValueOfText("maxLength", " 4 ")).toBe(4)
    expect(nativeValueOfText("colSpan", "2")).toBe(2)
    expect(nativeValueOfText("tabIndex", "abc")).toBe("abc")
    expect(nativeValueOfText("draggable", "true")).toBe(true)
    expect(nativeValueOfText("draggable", "false")).toBe(false)
    expect(nativeValueOfText("draggable", "")).toBe(false)
  })

  it("keeps the text of any other prop", () => {
    expect(nativeValueOfText("title", "0")).toBe("0")
    expect(nativeValueOfText("hidden", "until-found")).toBe("until-found")
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

describe("attributeText", () => {
  it("gives draggable the enumerated text a boolean reflects as, and any other boolean attribute presence", () => {
    expect(attributeText("draggable", true)).toBe("true")
    expect(attributeText("draggable", false)).toBe("false")
    expect(attributeText("hidden", true)).toBe("")
    expect(attributeText("hidden", false)).toBeNull()
    expect(attributeText("aria-hidden", false)).toBe("false")
  })
})
