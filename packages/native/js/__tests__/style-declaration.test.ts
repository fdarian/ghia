import { describe, expect, it } from "vitest"
import { keepWrittenEntries } from "../dom/style-declaration.js"

describe("keepWrittenEntries", () => {
  it("is the framework's style when nothing was written", () => {
    const before = { width: 1 }
    const after = { width: 2 }
    expect(keepWrittenEntries(before, before, after)).toBe(after)
  })

  it("keeps a written entry the commit left alone, and replaces one it changed", () => {
    const before = { width: 1, height: 2, opacity: 1 }
    const written = { width: 1, height: "9px", opacity: 1, "--x": "1px" }
    expect(keepWrittenEntries(written, before, { width: 5, height: 2, opacity: 0.5 })).toEqual({
      width: 5,
      height: "9px",
      opacity: 0.5,
      "--x": "1px",
    })
    expect(keepWrittenEntries(written, before, { width: 1, height: 3, opacity: 1 })).toEqual({
      width: 1,
      height: 3,
      opacity: 1,
      "--x": "1px",
    })
  })

  it("keeps a removal until the framework sets the entry again, and drops an entry the commit removed", () => {
    const before = { width: 1, height: 2 }
    expect(keepWrittenEntries({ width: 1 }, before, { width: 1, height: 2 })).toEqual({ width: 1 })
    expect(keepWrittenEntries({ width: 1 }, before, { width: 1, height: 3 })).toEqual({ width: 1, height: 3 })
    expect(keepWrittenEntries({ width: "9px", height: 2 }, before, { height: 2 })).toEqual({ height: 2 })
  })

  it("treats an undefined value as absent and takes undefined styles", () => {
    expect(keepWrittenEntries({ color: "red" }, undefined, undefined)).toEqual({ color: "red" })
    expect(keepWrittenEntries({}, { color: undefined }, { color: undefined })).toEqual({})
  })
})
