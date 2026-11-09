import { describe, expect, it } from "vitest"
import { SentWrites } from "../sent-writes.js"

describe("SentWrites", () => {
  it("writes a style once, whatever object holds it", () => {
    const sent = new SentWrites()
    expect(sent.writesStyle({ width: 1, hover: { color: "red" } })).toBe(true)
    expect(sent.writesStyle({ width: 1, hover: { color: "red" } })).toBe(false)
    expect(sent.writesStyle({ width: 2, hover: { color: "red" } })).toBe(true)
  })

  it("takes an empty style for none, and clears a style with an empty one", () => {
    const sent = new SentWrites()
    expect(sent.writesStyle({})).toBe(false)
    expect(sent.writesStyle({ width: 1 })).toBe(true)
    expect(sent.writesStyle({})).toBe(true)
    expect(sent.writesStyle({ width: undefined })).toBe(false)
  })

  it("sees a style object that was changed in place", () => {
    const sent = new SentWrites()
    const style = { width: 1, hover: { color: "red" } }
    expect(sent.writesStyle(style)).toBe(true)
    style.hover.color = "blue"
    expect(sent.writesStyle(style)).toBe(true)
    expect(sent.writesStyle(style)).toBe(false)
  })

  it("writes a style whose keys came in another order", () => {
    const sent = new SentWrites()
    expect(sent.writesStyle({ padding: 8, paddingLeft: 4 })).toBe(true)
    expect(sent.writesStyle({ paddingLeft: 4, padding: 8 })).toBe(true)
  })

  it("writes a style whose keys came in another order, or with one key added or dropped", () => {
    const sent = new SentWrites()
    expect(sent.writesStyle({ padding: 8, paddingLeft: 4 })).toBe(true)
    expect(sent.writesStyle({ padding: 8, paddingLeft: 4 })).toBe(false)
    expect(sent.writesStyle({ paddingLeft: 4, padding: 8 })).toBe(true)
    expect(sent.styleJson).toBe('{"paddingLeft":4,"padding":8}')
    expect(sent.writesStyle({ paddingLeft: 4, padding: 8, margin: 1 })).toBe(true)
    expect(sent.writesStyle({ paddingLeft: 4, padding: 8 })).toBe(true)
    expect(sent.writesStyle({ paddingLeft: 4 })).toBe(true)
  })

  it("takes a key holding undefined for an absent one", () => {
    const sent = new SentWrites()
    expect(sent.writesStyle({ width: 1, height: undefined, color: "red" })).toBe(true)
    expect(sent.styleJson).toBe('{"width":1,"color":"red"}')
    expect(sent.writesStyle({ width: 1, color: "red" })).toBe(false)
    expect(sent.writesStyle({ height: undefined, width: 1, color: "red", margin: undefined })).toBe(false)
    expect(sent.writesStyle({ width: 1, color: undefined })).toBe(true)
    expect(sent.writesStyle({ color: undefined, width: 1 })).toBe(false)
  })

  it("sees a primitive style object that was changed in place, whatever was changed", () => {
    const sent = new SentWrites()
    const style: Record<string, number | undefined> = { width: 1, height: 2 }
    expect(sent.writesStyle(style)).toBe(true)
    expect(sent.writesStyle(style)).toBe(false)
    style.width = 3
    expect(sent.writesStyle(style)).toBe(true)
    expect(sent.writesStyle(style)).toBe(false)
    style.margin = 4
    expect(sent.writesStyle(style)).toBe(true)
    delete style.height
    expect(sent.writesStyle(style)).toBe(true)
    expect(sent.styleJson).toBe('{"width":3,"margin":4}')
    style.margin = undefined
    expect(sent.writesStyle(style)).toBe(true)
    expect(sent.styleJson).toBe('{"width":3}')
  })

  it("compares by the JSON a value that is not equal to itself, and a function that JSON drops", () => {
    const sent = new SentWrites()
    expect(sent.writesStyle({ width: NaN })).toBe(true)
    expect(sent.styleJson).toBe('{"width":null}')
    expect(sent.writesStyle({ width: NaN })).toBe(false)
    expect(sent.writesStyle({ width: null })).toBe(false)
    expect(sent.writesStyle({ width: 0 })).toBe(true)
    expect(sent.writesStyle({ width: -0 })).toBe(false)
    expect(sent.writesStyle({ width: 0, onClick: () => {} })).toBe(false)
  })

  it("writes a nested or array style when it changed, and not when only its identity did", () => {
    const sent = new SentWrites()
    expect(sent.writesStyle({ width: 1, hover: { color: "red" }, items: [1, 2] })).toBe(true)
    expect(sent.writesStyle({ width: 1, hover: { color: "red" }, items: [1, 2] })).toBe(false)
    expect(sent.writesStyle({ width: 1, hover: { color: "blue" }, items: [1, 2] })).toBe(true)
    expect(sent.writesStyle({ width: 1, hover: { color: "blue" }, items: [1, 3] })).toBe(true)
    expect(sent.styleJson).toBe('{"width":1,"hover":{"color":"blue"},"items":[1,3]}')
    expect(sent.writesStyle({ width: 1 })).toBe(true)
    expect(sent.writesStyle({ width: 1, hover: undefined })).toBe(false)
    expect(sent.writesStyle({ width: 1, hover: { color: "red" } })).toBe(true)
  })

  it("writes a prop that was never written, even as null, and then only changes", () => {
    const sent = new SentWrites()
    expect(sent.writesProp("title", null)).toBe(true)
    expect(sent.writesProp("title", null)).toBe(false)
    expect(sent.writesProp("title", "a")).toBe(true)
    expect(sent.writesProp("title", "a")).toBe(false)
    expect(sent.writesProp("highlight", { query: "x" })).toBe(true)
    expect(sent.writesProp("highlight", { query: "x" })).toBe(false)
    expect(sent.writesProp("highlight", { query: "y" })).toBe(true)
  })

  it("writes everything again for a new native element", () => {
    const sent = new SentWrites()
    sent.writesStyle({ width: 1 })
    sent.writesProp("title", "a")
    sent.reset()
    expect(sent.writesStyle({ width: 1 })).toBe(true)
    expect(sent.writesProp("title", "a")).toBe(true)
  })
})
