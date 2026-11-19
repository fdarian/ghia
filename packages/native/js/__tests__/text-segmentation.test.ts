import { describe, expect, it } from "vitest"
import { wordAt } from "../dom/text-segmentation.js"

describe("the word at an offset (a double click)", () => {
  const text = "hello brave, world"

  it("is the word the offset is inside", () => {
    expect(wordAt(text, 8)).toEqual([6, 11])
    expect(wordAt(text, 1)).toEqual([0, 5])
  })

  it("is the word the offset touches when it is at an edge of it", () => {
    expect(wordAt(text, 0)).toEqual([0, 5])
    expect(wordAt(text, 5)).toEqual([0, 5])
    expect(wordAt(text, 6)).toEqual([6, 11])
    expect(wordAt(text, 11)).toEqual([6, 11])
    expect(wordAt(text, text.length)).toEqual([13, 18])
  })

  it("is the run of spaces or punctuation between two words", () => {
    expect(wordAt(text, 12)).toEqual([12, 13])
    expect(wordAt("a   b", 2)).toEqual([1, 4])
  })

  it("is nothing in an empty text", () => {
    expect(wordAt("", 0)).toBeUndefined()
  })
})
