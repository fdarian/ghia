import { describe, expect, it } from "vitest"
import { DOMRect, DOMRectList, DOMRectReadOnly } from "../dom/dom-rect.js"
import "../dom-globals.js"

describe("DOMRect and DOMRectReadOnly", () => {
  it("are globals", () => {
    expect(globalThis.DOMRect).toBe(DOMRect)
    expect(globalThis.DOMRectReadOnly).toBe(DOMRectReadOnly)
  })

  it("take x, y, width and height, defaulting to 0, and derive the edges", () => {
    expect(new DOMRect().toJSON()).toEqual({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 })
    const rect = new DOMRect(10, 20, 30, 40)
    expect([rect.left, rect.right, rect.top, rect.bottom]).toEqual([10, 40, 20, 60])
  })

  it("reads a negative size as a rect that extends left and up", () => {
    const rect = new DOMRect(50, 50, -20, -10)
    expect([rect.left, rect.right, rect.top, rect.bottom]).toEqual([30, 50, 40, 50])
  })

  it("fromRect leaves out what is missing", () => {
    const rect = DOMRect.fromRect({ x: 5, width: 7 })
    expect(rect).toBeInstanceOf(DOMRect)
    expect(rect.toJSON()).toMatchObject({ x: 5, y: 0, width: 7, height: 0 })
    expect(DOMRect.fromRect().width).toBe(0)
    expect(DOMRectReadOnly.fromRect({ x: 1 })).toBeInstanceOf(DOMRectReadOnly)
  })

  it("lets a DOMRect be set and moves its edges with it, and keeps a DOMRectReadOnly fixed", () => {
    const rect = new DOMRect(0, 0, 10, 10)
    rect.x = 4
    rect.width = 20
    expect(rect.left).toBe(4)
    expect(rect.right).toBe(24)
    expect(new DOMRect() instanceof DOMRectReadOnly).toBe(true)
    const fixed = new DOMRectReadOnly(1, 2, 3, 4)
    expect(Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "x")?.set).toBeUndefined()
    expect(fixed.x).toBe(1)
  })

  it("converts to numbers as the DOM does", () => {
    expect(new DOMRect("3" as unknown as number).x).toBe(3)
  })
})

describe("DOMRectList", () => {
  it("is an array with item()", () => {
    const list = new DOMRectList()
    const rect = new DOMRect(1, 2, 3, 4)
    list.push(rect)
    expect(list.length).toBe(1)
    expect(list.item(0)).toBe(rect)
    expect(list.item(1)).toBeNull()
    expect(Array.from(list)).toEqual([rect])
  })
})
