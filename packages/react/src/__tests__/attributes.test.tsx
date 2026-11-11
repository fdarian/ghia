/**
 * DOM attributes reach the native tree through `setAttribute`, so a selector matcher reads them without JS. Native reads
 * them for nothing but sheets, so they are sent once a `<style>` exists (or a sheet is adopted): the tests below mount one.
 */
import React from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
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
    const view = (props: Record<string, unknown>) => (
      <>
        <style />
        <div ref={(element: unknown) => { box = element }} {...props} />
      </>
    )
    app.render(view({ className: "a b", "data-x": "1", title: "t" }))
    expect([read("class"), read("data-x"), read("title")]).toEqual(["a b", "1", "t"])

    app.render(view({ className: "c", "data-x": 2 }))
    expect([read("class"), read("data-x"), read("title")]).toEqual(["c", "2", null])

    app.render(view({ className: "c", "data-x": true }))
    expect(read("data-x")).toBe("true")

    app.render(view({ className: "c", "data-x": false }))
    expect(read("data-x")).toBe("false")

    app.render(view({ className: "c", "data-x": true, hidden: true }))
    expect(read("hidden")).toBe("")
    app.render(view({ className: "c", "data-x": true, hidden: false }))
    expect(read("hidden")).toBeNull()

    app.render(view({}))
    expect([read("class"), read("data-x")]).toEqual([null, null])
  })

  it("keeps the class when a prop moves between className and class", () => {
    const view = (props: Record<string, unknown>) => (
      <>
        <style />
        <div ref={(element: unknown) => { box = element }} {...props} />
      </>
    )
    app.render(view({ className: "a b" }))
    expect(read("class")).toBe("a b")

    app.render(view({ class: "a b" }))
    expect(read("class")).toBe("a b")

    app.render(view({ className: "a b" }))
    expect(read("class")).toBe("a b")

    app.render(view({ class: "c" }))
    expect(read("class")).toBe("c")

    app.render(view({}))
    expect(read("class")).toBeNull()
  })

  it("sends nothing for a handler, a style or an object", () => {
    app.render(
      <>
        <style />
        <div
          ref={(element: unknown) => { box = element }}
          style={{ width: 4 }}
          onClick={() => {}}
          {...({ extra: { a: 1 } } as object)}
        />
      </>
    )
    for (const name of ["style", "onclick", "onClick", "extra"]) expect(read(name)).toBeNull()
  })

  it("names a prop as the DOM names its attribute, so a selector matches what React was given", () => {
    const refs: Record<string, any> = {}
    const ref = (name: string) => (element: unknown) => {
      refs[name] = element
    }
    const view = (tabIndex: number) => (
      <>
        <style>{`
          [tabindex="0"] { opacity: 0.25 }
          [data-rowid="7"] { padding-top: 3px }
          .x { padding-left: 5px }
          [for] { padding-right: 6px }
          svg[viewBox] { opacity: 0.5 }
          svg[viewbox] { padding-top: 9px }
        `}</style>
        <div ref={ref("div")} tabIndex={tabIndex} {...{ "data-rowId": "7" }} className="x" />
        <label ref={ref("label")} htmlFor="a" />
        <svg ref={ref("svg")} viewBox="0 0 1 1" />
      </>
    )
    app.render(view(0))
    const div = getComputedStyle(refs.div)
    expect([div.opacity, div.paddingTop, div.paddingLeft]).toEqual(["0.25", "3px", "5px"])
    expect(getComputedStyle(refs.label).paddingRight).toBe("6px")
    expect(app.renderer.getAttribute(refs.svg.nativeId, "viewBox")).toBe("0 0 1 1")
    expect(app.renderer.getAttribute(refs.svg.nativeId, "viewbox")).toBeNull()
    expect(getComputedStyle(refs.svg).opacity).toBe("0.5")
    expect(getComputedStyle(refs.svg).paddingTop).toBe("0px")

    app.render(view(-1))
    expect(getComputedStyle(refs.div).opacity).toBe("1")
    app.render(view(0))
    expect(getComputedStyle(refs.div).opacity).toBe("0.25")
  })
})
