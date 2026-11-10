/** DOM attributes reach the native tree through `setAttribute`, so a selector matcher reads them without JS. */
import React from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("attributes on native in React", () => {
  let app: TestRoot
  let box: any

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  const read = (name: string) => app.renderer.getAttribute(box.nativeId, name)

  it("sends className as class, data-* and primitive props, and removes them as they go", () => {
    const view = (props: Record<string, unknown>) => <div ref={(element: unknown) => { box = element }} {...props} />
    app.render(view({ className: "a b", "data-x": "1", title: "t" }))
    expect([read("class"), read("data-x"), read("title")]).toEqual(["a b", "1", "t"])

    app.render(view({ className: "c", "data-x": 2 }))
    expect([read("class"), read("data-x"), read("title")]).toEqual(["c", "2", null])

    app.render(view({ className: "c", "data-x": true }))
    expect(read("data-x")).toBe("")

    app.render(view({ "data-x": false }))
    expect([read("class"), read("data-x")]).toEqual([null, null])
  })

  it("sends nothing for a handler, a style or an object", () => {
    app.render(
      <div
        ref={(element: unknown) => { box = element }}
        style={{ width: 4 }}
        onClick={() => {}}
        {...({ extra: { a: 1 } } as object)}
      />
    )
    for (const name of ["style", "onclick", "onClick", "extra"]) expect(read(name)).toBeNull()
  })
})
