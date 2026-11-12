import { describe, expect, it } from "vitest"
import { normalizedInputType } from "../dom/input-type.js"

describe("normalizedInputType", () => {
  it("trims and lowercases a keyword, as native does", () => {
    expect(normalizedInputType(" Radio ")).toBe("radio")
    expect(normalizedInputType("DATETIME-LOCAL")).toBe("datetime-local")
  })

  it("is text for a missing, empty or unknown value", () => {
    for (const type of [undefined, null, "", "  ", "nonsense"]) expect(normalizedInputType(type)).toBe("text")
  })
})
