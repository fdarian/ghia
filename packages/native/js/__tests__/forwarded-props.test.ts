import { describe, expect, it } from "vitest"
import { attributeNameOfProp, forwardsCustomProp } from "../mutations.js"

describe("a prop that reaches native as an attribute", () => {
  it("is not also forwarded as a custom prop, on any element type", () => {
    for (const type of ["div", "canvas", "img", "input"]) {
      for (const name of ["class", "className", "data-x", "data-row-id"]) {
        expect([type, name, forwardsCustomProp(type, name)]).toEqual([type, name, false])
        expect(attributeNameOfProp(type, name)).toBe(name === "className" ? "class" : name)
      }
    }
  })

  it("leaves the other props of a non-built-in element forwarded and not sent as attributes", () => {
    expect(forwardsCustomProp("canvas", "width")).toBe(true)
    expect(attributeNameOfProp("canvas", "width")).toBeUndefined()
  })
})
