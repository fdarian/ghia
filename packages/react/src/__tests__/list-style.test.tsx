/** `li` is `display: list-item`, a list inside a list has Chrome's user agent margin, and the `list-style` properties are styles. */
import React from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("list styles in React", () => {
  let app: TestRoot

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  it("an li is a list item and a nested list has no block margin", () => {
    const refs: Record<string, any> = {}
    const ref = (name: string) => (element: unknown) => {
      refs[name] = element
    }
    app.render(
      <ul ref={ref("outer")}>
        <li ref={ref("item")}>
          a
          <ol ref={ref("inner")}>
            <li>b</li>
          </ol>
        </li>
      </ul>
    )
    expect(getComputedStyle(refs.item).display).toBe("list-item")
    expect(getComputedStyle(refs.outer).marginTop).toBe("16px")
    expect(getComputedStyle(refs.inner).marginTop).toBe("0px")
    expect(getComputedStyle(refs.inner).marginBottom).toBe("0px")
  })

  it("the properties are written as styles, in a sheet and inline, and an invalid value is dropped", () => {
    const refs: Record<string, any> = {}
    app.render(
      <div>
        <style>{`.sheet { list-style: square inside }`}</style>
        <ul ref={(element: unknown) => (refs.sheet = element)} className="sheet" />
        <ul ref={(element: unknown) => (refs.inline = element)} style={{ listStyleType: "lower-roman", listStylePosition: "inside" }} />
        <ul ref={(element: unknown) => (refs.invalid = element)} style={{ listStyleType: "greek" as never, opacity: 0.5 }} />
      </div>
    )
    expect(refs.inline.style.listStyleType).toBe("lower-roman")
    expect(refs.inline.style.listStylePosition).toBe("inside")
    expect(refs.invalid.style.opacity).toBe("0.5")
    expect(getComputedStyle(refs.invalid).opacity).toBe("0.5")
  })
})
