import { describe, expect, it } from "vitest"
import { attributesOfProps } from "../dom/attribute-names.js"
import { forwardsCustomProp } from "../mutations.js"

describe("a prop that reaches native as an attribute", () => {
  it("is not also forwarded as a custom prop, on any element type", () => {
    for (const type of ["div", "canvas", "img", "input"]) {
      for (const name of ["class", "className", "data-x", "data-row-id"]) {
        expect([type, name, forwardsCustomProp(type, name)]).toEqual([type, name, false])
      }
    }
  })

  it("is named as the DOM names it: lower case on HTML, as written on SVG", () => {
    const props = [
      ["tabIndex", 0],
      ["data-rowId", "7"],
      ["className", "x"],
      ["htmlFor", "a"],
      ["viewBox", "0 0 1 1"],
    ] as const
    expect([...attributesOfProps(props, "div")]).toEqual([
      ["tabindex", "0"],
      ["data-rowid", "7"],
      ["class", "x"],
      ["for", "a"],
      ["viewbox", "0 0 1 1"],
    ])
    expect([...attributesOfProps([["className", "x"], ["viewBox", "0 0 1 1"]], "svg")]).toEqual([
      ["class", "x"],
      ["viewBox", "0 0 1 1"],
    ])
  })

  it("is every prop the DOM lists as an attribute, whether or not native also reads it as a prop", () => {
    const attributes = attributesOfProps(
      [
        ["width", 4],
        ["id", "a"],
        ["role", "button"],
        ["hidden", true],
        ["disabled", false],
        ["data-open", false],
        ["aria-busy", true],
        ["onClick", () => {}],
        ["style", { color: "red" }],
        ["children", "x"],
        ["key", "k"],
        ["ref", () => {}],
        ["title", undefined],
      ],
      "div"
    )
    expect([...attributes]).toEqual([
      ["width", "4"],
      ["id", "a"],
      ["role", "button"],
      ["hidden", ""],
      ["data-open", "false"],
      ["aria-busy", "true"],
    ])
    expect(forwardsCustomProp("canvas", "width")).toBe(true)
  })

  it("is the prop written as the attribute when two props name it, else the first", () => {
    expect(attributesOfProps([["className", "a"], ["class", "b"]], "div").get("class")).toBe("b")
    expect(attributesOfProps([["class", "b"], ["className", "a"]], "div").get("class")).toBe("b")
    expect(attributesOfProps([["tabIndex", 1], ["TABINDEX", 2]], "div").get("tabindex")).toBe("1")
  })
})
