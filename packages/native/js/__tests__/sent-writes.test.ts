import { describe, expect, it, vi } from "vitest"
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

  // A style is taken apart only once a write of it turned out equal, so each case runs both with
  // that having happened ("settled": the next writes meet the snapshot) and without it.
  describe.each([
    ["settled", true],
    ["unsettled", false],
  ])("a style of primitives, %s", (_name, settle) => {
    /** A write that is sent; the same style again is equal. */
    const sends = (sent: SentWrites, style: object) => {
      expect(sent.writesStyle(style)).toBe(true)
      if (settle) expect(sent.writesStyle(style)).toBe(false)
    }

    it("is skipped when equal, and keeps the JSON of the last write", () => {
      const sent = new SentWrites()
      sends(sent, { width: 1, color: "red", flex: null, visible: true })
      expect(sent.styleJson).toBe('{"width":1,"color":"red","flex":null,"visible":true}')
      expect(sent.writesStyle({ width: 1, color: "red", flex: null, visible: true })).toBe(false)
      sends(sent, { width: 1, color: "red", flex: null, visible: false })
      expect(sent.styleJson).toBe('{"width":1,"color":"red","flex":null,"visible":false}')
      expect(sent.writesStyle({ width: 1, color: "red", flex: null, visible: false })).toBe(false)
    })

    it("is written when its keys came in another order, or one key is added or dropped", () => {
      const sent = new SentWrites()
      sends(sent, { padding: 8, paddingLeft: 4 })
      expect(sent.writesStyle({ padding: 8, paddingLeft: 4 })).toBe(false)
      sends(sent, { paddingLeft: 4, padding: 8 })
      expect(sent.styleJson).toBe('{"paddingLeft":4,"padding":8}')
      sends(sent, { paddingLeft: 4, padding: 8, margin: 1 })
      sends(sent, { paddingLeft: 4, padding: 8 })
      sends(sent, { paddingLeft: 4 })
    })

    it("takes a key holding undefined for an absent one", () => {
      const sent = new SentWrites()
      sends(sent, { width: 1, height: undefined, color: "red" })
      expect(sent.styleJson).toBe('{"width":1,"color":"red"}')
      expect(sent.writesStyle({ width: 1, color: "red" })).toBe(false)
      expect(sent.writesStyle({ height: undefined, width: 1, color: "red", margin: undefined })).toBe(false)
      sends(sent, { width: 1, color: undefined })
      expect(sent.writesStyle({ color: undefined, width: 1 })).toBe(false)
    })

    it("sees a style object that was changed in place, whatever was changed", () => {
      const sent = new SentWrites()
      const style: Record<string, number | undefined> = { width: 1, height: 2 }
      sends(sent, style)
      style.width = 3
      sends(sent, style)
      style.margin = 4
      sends(sent, style)
      delete style.height
      sends(sent, style)
      expect(sent.styleJson).toBe('{"width":3,"margin":4}')
      style.margin = undefined
      sends(sent, style)
      expect(sent.styleJson).toBe('{"width":3}')
    })

    it("falls back to the JSON for a value that is not equal to itself", () => {
      const sent = new SentWrites()
      expect(sent.writesStyle({ width: NaN })).toBe(true)
      expect(sent.styleJson).toBe('{"width":null}')
      expect(sent.writesStyle({ width: NaN })).toBe(false)
      expect(sent.writesStyle({ width: null })).toBe(false)
      sends(sent, { width: 0 })
      expect(sent.writesStyle({ width: -0 })).toBe(false)
    })
  })

  it("stringifies an equal primitive style once, and then not at all", () => {
    const sent = new SentWrites()
    const style = () => ({ width: 1, color: "red" })
    const stringify = vi.spyOn(JSON, "stringify")
    try {
      expect(sent.writesStyle(style())).toBe(true)
      expect(sent.writesStyle(style())).toBe(false)
      expect(stringify).toHaveBeenCalledTimes(2)
      for (let write = 0; write < 5; write++) expect(sent.writesStyle(style())).toBe(false)
      expect(stringify).toHaveBeenCalledTimes(2)
      expect(sent.writesStyle({ width: 2, color: "red" })).toBe(true)
      expect(stringify).toHaveBeenCalledTimes(3)
    } finally {
      stringify.mockRestore()
    }
  })

  describe("a style with an object in it", () => {
    it("is compared by its JSON, so an equal one is skipped and a changed one written", () => {
      const sent = new SentWrites()
      const stringify = vi.spyOn(JSON, "stringify")
      try {
        expect(sent.writesStyle({ width: 1, hover: { color: "red" }, items: [1, 2] })).toBe(true)
        expect(sent.writesStyle({ width: 1, hover: { color: "red" }, items: [1, 2] })).toBe(false)
        expect(stringify).toHaveBeenCalledTimes(2)
      } finally {
        stringify.mockRestore()
      }
      expect(sent.writesStyle({ width: 1, hover: { color: "blue" }, items: [1, 2] })).toBe(true)
      expect(sent.writesStyle({ width: 1, hover: { color: "blue" }, items: [1, 3] })).toBe(true)
      expect(sent.styleJson).toBe('{"width":1,"hover":{"color":"blue"},"items":[1,3]}')
    })

    it("is not mistaken for the primitives written before it, nor they for it", () => {
      const sent = new SentWrites()
      expect(sent.writesStyle({ width: 1 })).toBe(true)
      expect(sent.writesStyle({ width: 1, hover: { color: "red" } })).toBe(true)
      expect(sent.writesStyle({ width: 1 })).toBe(true)
      expect(sent.writesStyle({ width: 1 })).toBe(false)
      expect(sent.writesStyle({ width: 1, hover: { color: "red" } })).toBe(true)
      expect(sent.writesStyle({ width: 1, hover: undefined })).toBe(true)
      expect(sent.writesStyle({ width: 1 })).toBe(false)
    })

    it("a function value is dropped by the JSON, so the style stays equal", () => {
      const sent = new SentWrites()
      expect(sent.writesStyle({ width: 1 })).toBe(true)
      expect(sent.writesStyle({ width: 1, onClick: () => {} })).toBe(false)
      expect(sent.writesStyle({ width: 2, onClick: () => {} })).toBe(true)
      expect(sent.styleJson).toBe('{"width":2}')
    })

    it("an object changed in place is written", () => {
      const sent = new SentWrites()
      const style = { width: 1, hover: { color: "red" } }
      expect(sent.writesStyle(style)).toBe(true)
      style.hover.color = "blue"
      expect(sent.writesStyle(style)).toBe(true)
      style.hover = { color: "blue" }
      expect(sent.writesStyle(style)).toBe(false)
    })
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
