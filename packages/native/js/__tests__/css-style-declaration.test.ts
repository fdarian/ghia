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
    const subject = declare()
    expect(subject.style).toBeInstanceOf(CSSStyleDeclaration)
  })

  it("is made once for an element and kept", () => {
    const owner = { style: {} as StyleDesc }
    const binding = { style: owner.style, setStyle: () => {} }
    expect(styleDeclarationFor(owner, binding)).toBe(styleDeclarationFor(owner, binding))
  })

  it("writes kebab-case names to the StyleDesc keys", () => {
    const subject = declare()
    subject.style.setProperty("background-color", "red")
    subject.style.setProperty("Flex-Direction", "column")
    subject.style.setProperty("transform-origin", "50% 50%")
    subject.style.setProperty("-webkit-font-smoothing", "antialiased")
    expect(subject.owner.style).toEqual({
      backgroundColor: "red",
      flexDirection: "column",
      transformOrigin: "50% 50%",
      WebkitFontSmoothing: "antialiased",
    })
    expect(subject.style.getPropertyValue("BACKGROUND-COLOR")).toBe("red")
  })

  it("keeps custom properties verbatim, case included", () => {
    const subject = declare()
    subject.style.setProperty("--dnd-Top", " 10px ")
    expect(subject.owner.style).toEqual({ "--dnd-Top": "10px" })
    expect(subject.style.getPropertyValue("--dnd-Top")).toBe("10px")
    expect(subject.style.getPropertyValue("--dnd-top")).toBe("")
  })

  it("has a camelCase member for every style property, to read and to write", () => {
    const subject = declare()
    subject.style.backgroundColor = "red"
    subject.style.translate = "10px 20px"
    subject.style.scale = "1.5"
    expect(subject.owner.style).toEqual({ backgroundColor: "red", translate: "10px 20px", scale: "1.5" })
    expect(subject.style.translate).toBe("10px 20px")
    expect(Object.keys(STYLE_PROPERTIES).every((key) => key in subject.style)).toBe(true)
    subject.style.backgroundColor = ""
    expect(subject.owner.style).toEqual({ translate: "10px 20px", scale: "1.5" })
  })

  it("stores a number for the properties native reads only as a number", () => {
    const subject = declare()
    subject.style.setProperty("opacity", "0.5")
    subject.style.zIndex = "3" as never
    expect(subject.owner.style).toEqual({ opacity: 0.5, zIndex: 3 })
    expect(subject.style.opacity).toBe("0.5")
  })

  it("passes text that is not a number on to native, so auto, none, percentages and keywords are not dropped", () => {
    const subject = declare()
    subject.style.zIndex = "10" as never
    expect(subject.owner.style).toEqual({ zIndex: 10 })
    subject.style.zIndex = "auto" as never
    expect(subject.owner.style).toEqual({ zIndex: "auto" })
    subject.style.opacity = "50%" as never
    subject.style.lineClamp = "none" as never
    subject.style.flexGrow = "inherit" as never
    expect(subject.owner.style).toEqual({ zIndex: "auto", opacity: "50%", lineClamp: "none", flexGrow: "inherit" })
    expect(subject.style.cssText).toBe("z-index: auto; opacity: 50%; line-clamp: none; flex-grow: inherit;")
    subject.style.cssText = "z-index: auto; opacity: 0.25"
    expect(subject.owner.style).toEqual({ zIndex: "auto", opacity: 0.25 })
  })

  it("removes a property for an empty value or null, and ignores what it cannot hold", () => {
    const subject = declare({ width: "10px", height: "5px" })
    subject.style.setProperty("width", "")
    subject.style.setProperty("height", null)
    expect(subject.owner.style).toEqual({})
    const writes = subject.owner.writes
    subject.style.setProperty("touch-action", "none")
    subject.style.setProperty("width", "10px !important")
    subject.style.setProperty("width", "1px", "bogus")
    expect(subject.owner.writes).toBe(writes)
  })

  it("holds priority important as the value's !important suffix, and reads the plain value", () => {
    const subject = declare()
    subject.style.setProperty("top", "1px", "important")
    expect(subject.owner.style).toEqual({ top: "1px !important" })
    expect(subject.style.getPropertyPriority("top")).toBe("important")
    expect(subject.style.getPropertyValue("top")).toBe("1px")
    expect(subject.style.top).toBe("1px")
    expect(subject.style.cssText).toBe("top: 1px !important;")
    subject.style.setProperty("top", "2px")
    expect(subject.style.getPropertyPriority("top")).toBe("")
    subject.style.setProperty("top", "3px", "important")
    expect(subject.style.removeProperty("top")).toBe("3px")
  })

  it("returns the old value from removeProperty, empty when there was none", () => {
    const subject = declare({ width: 10, "--a": "1" })
    expect(subject.style.removeProperty("width")).toBe("10px")
    expect(subject.style.removeProperty("--a")).toBe("1")
    expect(subject.style.removeProperty("width")).toBe("")
    expect(subject.style.removeProperty("nonsense")).toBe("")
    expect(subject.owner.style).toEqual({})
  })

  it("writes nothing for a value the style already has", () => {
    const subject = declare({ width: "10px" })
    subject.style.setProperty("width", "10px")
    subject.style.removeProperty("height")
    expect(subject.owner.writes).toBe(0)
  })

  it("never changes the live style object in place", () => {
    const initial: StyleDesc = { width: "1px" }
    const subject = declare(initial)
    subject.style.setProperty("height", "2px")
    expect(initial).toEqual({ width: "1px" })
    expect(subject.owner.style).not.toBe(initial)
  })

  it("writes a property last, as CSS lets the later of a shorthand and a longhand win", () => {
    const subject = declare({ padding: 4, paddingTop: 8 })
    subject.style.setProperty("padding", "2px")
    expect(Object.keys(subject.owner.style)).toEqual(["paddingTop", "padding"])
  })

  it("moves a property last even when its value did not change", () => {
    const subject = declare()
    subject.style.marginLeft = "5px"
    subject.style.margin = "0"
    subject.style.marginLeft = "5px"
    expect(Object.keys(subject.owner.style)).toEqual(["margin", "marginLeft"])
  })

  it("replaces a declaration where it stands, and writes nothing for an unchanged one beside a changing one", () => {
    const subject = declare({ transition: "opacity 1s", transform: "none", color: "red" })
    subject.style.transform = "rotate(1deg)"
    expect(Object.keys(subject.owner.style)).toEqual(["transition", "transform", "color"])
    expect(subject.owner.writes).toBe(1)
    subject.style.transition = "opacity 1s"
    expect(subject.owner.writes, "an unchanged value is no change").toBe(1)
    expect(Object.keys(subject.owner.style)).toEqual(["transition", "transform", "color"])
    subject.style.transition = "opacity 2s"
    expect(Object.keys(subject.owner.style)).toEqual(["transition", "transform", "color"])
    expect(subject.owner.writes).toBe(2)
  })

  it("moves a declaration last only when a later one overlaps it", () => {
    const subject = declare({ borderTop: "1px solid red", color: "red", borderWidth: 2 })
    subject.style.setProperty("color", "blue")
    expect(Object.keys(subject.owner.style)).toEqual(["borderTop", "color", "borderWidth"])
    subject.style.setProperty("border-top", "2px solid red")
    expect(Object.keys(subject.owner.style), "borderWidth covers a width borderTop does").toEqual(["color", "borderWidth", "borderTop"])
  })

  it("serializes cssText as Chrome writes it", () => {
    const subject = declare({ width: 10, opacity: 0.5, "--dnd-top": "10px", translate: "1px 2px", rotate: 45, flexGrow: 1 })
    expect(subject.style.cssText).toBe("width: 10px; opacity: 0.5; --dnd-top: 10px; translate: 1px 2px; rotate: 45deg; flex-grow: 1;")
    expect(declare().style.cssText).toBe("")
  })

  it("leaves out what is not a declaration: state blocks, undefined and objects", () => {
    const subject = declare({ width: 1, height: undefined, hover: { width: 2 }, "@container": {} } as StyleDesc)
    expect(subject.style.cssText).toBe("width: 1px;")
    expect(subject.style.length).toBe(1)
  })

  it("round-trips cssText through the setter", () => {
    const subject = declare({ hover: { opacity: 0.5 }, color: "red" })
    subject.style.cssText = "width: 10px; --a: url(a;b) 'x;y'; OPACITY: .5 !important; bogus: 1; : 2; color"
    expect(subject.owner.style).toEqual({ hover: { opacity: 0.5 }, width: "10px", "--a": "url(a;b) 'x;y'", opacity: ".5 !important" })
    const text = subject.style.cssText
    subject.style.cssText = ""
    subject.style.cssText = text
    expect(subject.style.cssText).toBe(text)
    subject.style.cssText = ""
    expect(subject.owner.style).toEqual({ hover: { opacity: 0.5 } })
  })

  it("lists its declarations: length, item and iteration", () => {
    const subject = declare({ width: 1, "--a": "b", display: "flex" })
    expect(subject.style.length).toBe(3)
    expect([subject.style.item(0), subject.style.item(1), subject.style.item(2), subject.style.item(3)]).toEqual(["width", "--a", "display", ""])
    expect([...subject.style]).toEqual(["width", "--a", "display"])
  })

  it("reads a number the framework wrote as the text CSS has", () => {
    const subject = declare({ width: 10, top: 0, fontWeight: 600, scale: 2, flex: 1 })
    expect([subject.style.width, subject.style.top, subject.style.fontWeight, subject.style.scale, subject.style.flex]).toEqual(["10px", "0", "600", "2", "1"])
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
  it("replaces what changed where it stands, and moves it last only for a later overlapping property", () => {
    const live = { transition: "a", transform: "x", padding: 1, paddingTop: 2 } as StyleDesc
    const result = applyStyleChange(live, { transform: "x", padding: 1 }, { transform: "y", padding: 3 })
    expect(Object.keys(result)).toEqual(["transition", "transform", "paddingTop", "padding"])
  })

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

  it("moves what the framework changed after what code wrote earlier", () => {
    const result = applyStyleChange({ padding: 1, paddingTop: 2 } as StyleDesc, { paddingTop: 2 }, { paddingTop: 3 })
    expect(Object.keys(result)).toEqual(["padding", "paddingTop"])
    expect(result).toEqual({ padding: 1, paddingTop: 3 })
    const shorthand = applyStyleChange({ padding: 1, paddingTop: 2 } as StyleDesc, { padding: 1 }, { padding: 3 })
    expect(Object.keys(shorthand)).toEqual(["paddingTop", "padding"])
  })

  it("does not change the live style in place", () => {
    applyStyleChange(live, { width: "1px" }, { width: "2px" })
    expect(live.width).toBe("7px")
  })
})
