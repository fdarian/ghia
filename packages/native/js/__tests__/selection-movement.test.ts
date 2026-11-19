import { describe, expect, it } from "vitest"
import { movePoint, stepPoint } from "../dom/selection-movement.js"
import { isSingleGrapheme, nextStop } from "../dom/text-segmentation.js"
import { bindingReads, editable, el, island, n, tx } from "./fixtures/fake-dom.js"

describe("text segmentation", () => {
  it("isSingleGrapheme: one cluster, however many code units", () => {
    expect([isSingleGrapheme("a"), isSingleGrapheme("👨‍👩‍👧"), isSingleGrapheme("é"), isSingleGrapheme("ab"), isSingleGrapheme("")]).toEqual([
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it("nextStop by character moves over one cluster and stops at both ends", () => {
    const text = "a👨‍👩‍👧b"
    const family = "👨‍👩‍👧".length
    expect(nextStop(text, 0, true, "character")).toBe(1)
    expect(nextStop(text, 1, true, "character")).toBe(1 + family)
    expect(nextStop(text, 1 + family, false, "character")).toBe(1)
    expect(nextStop(text, 2, false, "character")).toBe(1)
    expect(nextStop(text, 0, false, "character")).toBeUndefined()
    expect(nextStop(text, text.length, true, "character")).toBeUndefined()
  })

  it("nextStop by word", () => {
    expect(nextStop("one two", 0, true, "word")).toBe(3)
    expect(nextStop("one two", 3, true, "word")).toBe(7)
    expect(nextStop("one two", 7, false, "word")).toBe(4)
  })
})

describe("movement", () => {
  it("steps by a grapheme inside a Text and over a block edge as one step", () => {
    const a = tx("ab")
    const b = tx("cd")
    const host = editable("div", el("p", a), el("p", b))
    expect(movePoint(n(host), n(a), 0, true, "character")).toMatchObject({ node: n(a), offset: 1 })
    // "ab\ncd": the break is one stop, so one step from the end of `ab` is the start of `cd`.
    const over = movePoint(n(host), n(a), 2, true, "character")
    expect([over?.node, over?.offset]).toEqual([n(b), 0])
    expect(movePoint(n(host), n(b), 0, false, "character")).toMatchObject({ node: n(a), offset: 2 })
    expect(movePoint(n(host), n(a), 0, false, "character")).toBeNull()
    expect(movePoint(n(host), n(b), 2, true, "character")).toBeNull()
  })

  it("reads only the block around the caret while the step stays inside it", () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => ({ text: tx(`paragraph ${index}`) }))
    const host = editable("div", ...paragraphs.map((paragraph) => el("p", paragraph.text)))
    const here = paragraphs[10].text
    const baseline = paragraphs.map((paragraph) => bindingReads(paragraph.text))
    expect(movePoint(n(host), n(here), 4, true, "character")).toMatchObject({ node: n(here), offset: 5 })
    expect(movePoint(n(host), n(here), 4, true, "word")).toMatchObject({ node: n(here), offset: 9 })
    paragraphs.forEach((paragraph, index) => {
      if (index !== 10) expect(bindingReads(paragraph.text)).toBe(baseline[index])
    })
  })

  it("widens to the block above only when the step crosses the edge", () => {
    const first = tx("one")
    const second = tx("two")
    const host = editable("div", el("p", first), el("p", second))
    const before = bindingReads(first)
    movePoint(n(host), n(second), 2, false, "character")
    expect(bindingReads(first)).toBe(before)
    expect(movePoint(n(host), n(second), 0, false, "character")).toMatchObject({ node: n(first), offset: 3 })
    expect(bindingReads(first)).toBeGreaterThan(before)
  })

  it("a contenteditable=false element is one atomic stop: skipped by movement, whole for a deletion step", () => {
    const before = tx("ab")
    const inside = tx("island")
    const atom = island("span", inside)
    const after = tx("cd")
    const host = editable("div", before, atom, after)
    const over = stepPoint(n(host), n(before), 2, true, "character")
    expect(over?.island).toBe(n(atom))
    expect([over?.node, over?.offset]).toEqual([n(host), 2])
    const back = stepPoint(n(host), n(after), 0, false, "character")
    expect(back?.island).toBe(n(atom))
    expect([back?.node, back?.offset]).toEqual([n(before), 2])
    // Its text is not in the model: a point inside it has nowhere to move.
    expect(stepPoint(n(host), n(inside), 2, true, "character")).toBeNull()
    // Word movement goes past it to the end of the next word.
    expect(stepPoint(n(host), n(before), 2, true, "word")).toMatchObject({ node: n(after), offset: 2, island: null })
  })

  it("a scope that is not an editing host has no islands", () => {
    const inside = tx("island")
    const atom = island("span", inside)
    const root = el("div", tx("ab"), atom)
    expect(stepPoint(n(root), n(inside), 2, true, "character")).toMatchObject({ node: n(inside), offset: 3, island: null })
  })
})
