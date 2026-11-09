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
