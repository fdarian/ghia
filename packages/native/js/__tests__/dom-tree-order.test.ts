import { describe, expect, it } from "vitest"
import { Range } from "../dom/range.js"
import { childCount, comparePoints, isInclusiveAncestor, isInclusiveDescendantBelow, nodeLength, rootOf } from "../dom/tree-order.js"
import { bindingReads, el, n, tx } from "./fixtures/fake-dom.js"

describe("tree order", () => {
  const a = tx("hello")
  const b = tx("world")
  const c = tx("again")
  const inner = el("p", b)
  const root = el("div", a, inner, c)
  const stray = tx("lost")

  it("nodeLength is the data length of text and the child count of anything else", () => {
    expect([nodeLength(n(a)), nodeLength(n(root)), nodeLength(n(inner))]).toEqual([5, 3, 1])
    expect([childCount(n(a)), childCount(n(root))]).toEqual([0, 3])
  })

  it("rootOf and the ancestor walks", () => {
    expect(rootOf(n(b))).toBe(n(root))
    expect(rootOf(n(stray))).toBe(n(stray))
    expect(isInclusiveAncestor(n(root), n(b))).toBe(true)
    expect(isInclusiveAncestor(n(b), n(b))).toBe(true)
    expect(isInclusiveAncestor(n(b), n(root))).toBe(false)
    expect(isInclusiveDescendantBelow(n(b), n(inner), n(root))).toBe(true)
    expect(isInclusiveDescendantBelow(n(a), n(inner), n(root))).toBe(false)
    expect(isInclusiveDescendantBelow(n(root), n(root), n(root))).toBe(false)
  })

  it("comparePoints: the standard's position of a boundary point", () => {
    expect(comparePoints(n(a), 2, n(a), 2)).toBe(0)
    expect(comparePoints(n(a), 1, n(a), 2)).toBe(-1)
    expect(comparePoints(n(a), 3, n(a), 2)).toBe(1)
    // Siblings, and a point in a text against one in a later subtree.
    expect(comparePoints(n(a), 5, n(b), 0)).toBe(-1)
    expect(comparePoints(n(c), 0, n(b), 5)).toBe(1)
    // An ancestor's point against a descendant: before the child at its offset, after the ones below.
    expect(comparePoints(n(root), 1, n(b), 0)).toBe(-1)
    expect(comparePoints(n(root), 2, n(b), 0)).toBe(1)
    expect(comparePoints(n(b), 0, n(root), 1)).toBe(1)
    expect(comparePoints(n(b), 0, n(root), 2)).toBe(-1)
    expect(comparePoints(n(root), 1, n(inner), 0)).toBe(-1)
    expect(comparePoints(n(inner), 1, n(root), 2)).toBe(-1)
    expect(comparePoints(n(inner), 1, n(root), 1)).toBe(1)
  })

  it("comparePoints throws for two trees", () => {
    expect(() => comparePoints(n(stray), 0, n(a), 0)).toThrow(/same tree/)
  })

  it("a removal looks no higher than the parent of what leaves for a range outside it", () => {
    const text = tx("far")
    const gone = tx("gone")
    const section = el("section", el("p", text), gone)
    const top = el("main", section, el("section", tx("other")))
    const range = new Range()
    range.setStart(n(text), 1)
    range.setEnd(n(text), 2)
    const before = bindingReads(top)
    n(section).removeChild(n(gone))
    expect(bindingReads(top)).toBe(before)
    expect([range.startContainer, range.startOffset]).toEqual([n(text), 1])
    n(top).removeChild(n(section))
    expect([range.startContainer, range.startOffset, range.endContainer, range.endOffset]).toEqual([n(top), 0, n(top), 0])
  })
})
