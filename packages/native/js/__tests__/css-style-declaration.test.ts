import { describe, expect, it } from "vitest"
import { applyStyleChange, CSSStyleDeclaration, serializeStyle, styleDeclarationFor } from "../dom/css-style-declaration.js"
import type { StyleDesc } from "../host.js"
import { STYLE_PROPERTIES } from "../style-properties.js"
import "../dom-globals.js"

/** An element's live style, and what the declaration handed back to it. */
function declare(initial: StyleDesc = {}) {
  const owner = { style: initial, writes: 0 }
  const binding = {
    get style() {
      return owner.style
    },
    setStyle(next: StyleDesc) {
      owner.style = next
      owner.writes += 1
    },
  }
  return { owner, style: styleDeclarationFor(owner, binding) }
}

describe("CSSStyleDeclaration", () => {
  it("is a class with no public constructor, and is on the global", () => {
    expect(() => new (CSSStyleDeclaration as unknown as new () => object)()).toThrow("Illegal constructor")
    expect(Reflect.get(globalThis, "CSSStyleDeclaration")).toBe(CSSStyleDeclaration)
    const { style } = declare()
    expect(style).toBeInstanceOf(CSSStyleDeclaration)
  })

  it("is made once for an element and kept", () => {
    const owner = { style: {} as StyleDesc }
    const binding = { style: owner.style, setStyle: () => {} }
    expect(styleDeclarationFor(owner, binding)).toBe(styleDeclarationFor(owner, binding))
  })

  it("writes kebab-case names to the StyleDesc keys", () => {
    const { owner, style } = declare()
    style.setProperty("background-color", "red")
    style.setProperty("Flex-Direction", "column")
    style.setProperty("transform-origin", "50% 50%")
    style.setProperty("-webkit-font-smoothing", "antialiased")
    expect(owner.style).toEqual({
      backgroundColor: "red",
      flexDirection: "column",
      transformOrigin: "50% 50%",
      WebkitFontSmoothing: "antialiased",
    })
    expect(style.getPropertyValue("BACKGROUND-COLOR")).toBe("red")
  })

  it("keeps custom properties verbatim, case included", () => {
    const { owner, style } = declare()
    style.setProperty("--dnd-Top", " 10px ")
    expect(owner.style).toEqual({ "--dnd-Top": "10px" })
    expect(style.getPropertyValue("--dnd-Top")).toBe("10px")
    expect(style.getPropertyValue("--dnd-top")).toBe("")
  })

  it("has a camelCase member for every style property, to read and to write", () => {
    const { owner, style } = declare()
    style.backgroundColor = "red"
    style.translate = "10px 20px"
    style.scale = "1.5"
    expect(owner.style).toEqual({ backgroundColor: "red", translate: "10px 20px", scale: "1.5" })
    expect(style.translate).toBe("10px 20px")
    expect(Object.keys(STYLE_PROPERTIES).every((key) => key in style)).toBe(true)
    style.backgroundColor = ""
    expect(owner.style).toEqual({ translate: "10px 20px", scale: "1.5" })
  })

  it("stores a number for the properties native reads only as a number", () => {
    const { owner, style } = declare()
    style.setProperty("opacity", "0.5")
    style.zIndex = "3" as never
    style.setProperty("order", "x")
    expect(owner.style).toEqual({ opacity: 0.5, zIndex: 3 })
    expect(style.opacity).toBe("0.5")
  })

  it("removes a property for an empty value or null, and ignores what it cannot hold", () => {
    const { owner, style } = declare({ width: "10px", height: "5px" })
    style.setProperty("width", "")
    style.setProperty("height", null)
    expect(owner.style).toEqual({})
    const writes = owner.writes
    style.setProperty("touch-action", "none")
    style.setProperty("width", "10px !important")
    style.setProperty("width", "1px", "bogus")
    expect(owner.writes).toBe(writes)
  })

  it("accepts priority important and ignores it", () => {
    const { owner, style } = declare()
    style.setProperty("top", "1px", "important")
    expect(owner.style).toEqual({ top: "1px" })
    expect(style.getPropertyPriority("top")).toBe("")
  })

  it("returns the old value from removeProperty, empty when there was none", () => {
    const { owner, style } = declare({ width: 10, "--a": "1" })
    expect(style.removeProperty("width")).toBe("10px")
    expect(style.removeProperty("--a")).toBe("1")
    expect(style.removeProperty("width")).toBe("")
    expect(style.removeProperty("nonsense")).toBe("")
    expect(owner.style).toEqual({})
  })

  it("writes nothing for a value the style already has", () => {
    const { owner, style } = declare({ width: "10px" })
    style.setProperty("width", "10px")
    style.removeProperty("height")
    expect(owner.writes).toBe(0)
  })

  it("never changes the live style object in place", () => {
    const initial: StyleDesc = { width: "1px" }
    const { owner, style } = declare(initial)
    style.setProperty("height", "2px")
    expect(initial).toEqual({ width: "1px" })
    expect(owner.style).not.toBe(initial)
  })

  it("writes a property last, as CSS lets the later of a shorthand and a longhand win", () => {
    const { owner, style } = declare({ padding: 4, paddingTop: 8 })
    style.setProperty("padding", "2px")
    expect(Object.keys(owner.style)).toEqual(["paddingTop", "padding"])
  })

  it("serializes cssText as Chrome writes it", () => {
    const { style } = declare({ width: 10, opacity: 0.5, "--dnd-top": "10px", translate: "1px 2px", rotate: "45deg", flexGrow: 1 })
    expect(style.cssText).toBe("width: 10px; opacity: 0.5; --dnd-top: 10px; translate: 1px 2px; rotate: 45deg; flex-grow: 1;")
    expect(declare().style.cssText).toBe("")
  })

  it("leaves out what is not a declaration: state blocks, undefined and objects", () => {
    const { style } = declare({ width: 1, height: undefined, hover: { width: 2 }, "@container": {} } as StyleDesc)
    expect(style.cssText).toBe("width: 1px;")
    expect(style.length).toBe(1)
  })

  it("round-trips cssText through the setter", () => {
    const { owner, style } = declare({ hover: { opacity: 0.5 }, color: "red" })
    style.cssText = "width: 10px; --a: url(a;b) 'x;y'; OPACITY: .5 !important; bogus: 1; : 2; color"
    expect(owner.style).toEqual({ hover: { opacity: 0.5 }, width: "10px", "--a": "url(a;b) 'x;y'", opacity: 0.5 })
    const text = style.cssText
    style.cssText = ""
    style.cssText = text
    expect(style.cssText).toBe(text)
    style.cssText = ""
    expect(owner.style).toEqual({ hover: { opacity: 0.5 } })
  })

  it("lists its declarations: length, item and iteration", () => {
    const { style } = declare({ width: 1, "--a": "b", display: "flex" })
    expect(style.length).toBe(3)
    expect([style.item(0), style.item(1), style.item(2), style.item(3)]).toEqual(["width", "--a", "display", ""])
    expect([...style]).toEqual(["width", "--a", "display"])
  })

  it("reads a number the framework wrote as the text CSS has", () => {
    const { style } = declare({ width: 10, top: 0, fontWeight: 600, scale: 2, flex: 1 })
    expect([style.width, style.top, style.fontWeight, style.scale, style.flex]).toEqual(["10px", "0", "600", "2", "1"])
  })

  it("has no parent rule", () => {
    expect(declare().style.parentRule).toBeNull()
  })
})

describe("serializeStyle", () => {
  it("is empty for an empty style", () => {
    expect(serializeStyle({})).toBe("")
  })
})

describe("applyStyleChange", () => {
  const live = { width: "7px", "--code": "1", height: 4 } as StyleDesc

  it("keeps what the framework did not change, code's included", () => {
    const result = applyStyleChange(live, { height: 4 }, { height: 4, color: "red" })
    expect(result).toEqual({ width: "7px", "--code": "1", height: 4, color: "red" })
  })

  it("overwrites what the framework changed", () => {
    expect(applyStyleChange(live, { width: "1px" }, { width: "2px" })).toEqual({ width: "2px", "--code": "1", height: 4 })
  })

  it("removes what the framework had and no longer has, and what it set undefined", () => {
    expect(applyStyleChange(live, { width: "1px", height: 4 }, {})).toEqual({ "--code": "1" })
    expect(applyStyleChange(live, { width: "1px" }, { width: undefined })).toEqual({ "--code": "1", height: 4 })
  })

  it("does not take a state block rebuilt with the same values for a change", () => {
    const hovered = { ...live, hover: { opacity: 1 } } as StyleDesc
    const result = applyStyleChange(hovered, { hover: { opacity: 1 } } as StyleDesc, { hover: { opacity: 1 } } as StyleDesc)
    expect(result).toEqual(hovered)
  })

  it("keeps the place of a property that is already there", () => {
    const result = applyStyleChange({ padding: 1, paddingTop: 2 } as StyleDesc, { padding: 1 }, { padding: 3 })
    expect(Object.keys(result)).toEqual(["padding", "paddingTop"])
  })

  it("does not change the live style in place", () => {
    applyStyleChange(live, { width: "1px" }, { width: "2px" })
    expect(live.width).toBe("7px")
  })
})
