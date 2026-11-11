/**
 * DOM attributes reach the native tree through `setAttribute`, so a selector matcher reads them without JS. Native reads
 * them for nothing but sheets, so they are sent once a `<style>` exists (or a sheet is adopted): the tests below mount one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSignal } from "solid-js"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("attributes on native in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  it("sends class, data-* and primitive props, and removes them as they go", () => {
    let box: any
    const [klass, setKlass] = createSignal<string | undefined>("a b")
    const [data, setData] = createSignal<string | number | boolean | undefined>("1")
    const [title, setTitle] = createSignal<string | undefined>("t")
    app.render(() => (
      <>
        <style />
        <div ref={(element: unknown) => (box = element)} class={klass()} data-x={data()} title={title()} />
      </>
    ))
    const read = (name: string) => app.renderer.getAttribute(box.nativeId, name)
    expect([read("class"), read("data-x"), read("title")]).toEqual(["a b", "1", "t"])

    app.flushSync(() => {
      setKlass("c")
      setData(2)
      setTitle(undefined)
    })
    expect([read("class"), read("data-x"), read("title")]).toEqual(["c", "2", null])

    app.flushSync(() => setData(true))
    expect(read("data-x")).toBe("true")

    app.flushSync(() => setData(false))
    expect(read("data-x")).toBe("false")

    app.flushSync(() => {
      setData(undefined)
      setKlass(undefined)
    })
    expect([read("class"), read("data-x")]).toEqual([null, null])
  })

  it("sends nothing for a handler, a style or an object", () => {
    let box: any
    app.render(() => (
      <>
        <style />
        <div
          ref={(element: unknown) => (box = element)}
          style={{ width: 4 }}
          onClick={() => {}}
          {...({ extra: { a: 1 } } as object)}
        />
      </>
    ))
    for (const name of ["style", "onclick", "onClick", "extra"]) {
      expect(app.renderer.getAttribute(box.nativeId, name)).toBeNull()
    }
  })

  it("names a prop as the DOM names its attribute, so a selector matches what Solid was given", () => {
    const refs: Record<string, any> = {}
    const ref = (name: string) => (element: unknown) => {
      refs[name] = element
    }
    const [tabIndex, setTabIndex] = createSignal(0)
    app.render(() => (
      <>
        <style>{`
          [tabindex="0"] { opacity: 0.25 }
          [data-rowid="7"] { padding-top: 3px }
          .x { padding-left: 5px }
          [for] { padding-right: 6px }
          svg[viewBox] { opacity: 0.5 }
          svg[viewbox] { padding-top: 9px }
        `}</style>
        <div ref={ref("div")} tabIndex={tabIndex()} {...{ "data-rowId": "7" }} className="x" />
        <label ref={ref("label")} htmlFor="a" />
        <svg ref={ref("svg")} viewBox="0 0 1 1" />
      </>
    ))
    const div = getComputedStyle(refs.div)
    expect([div.opacity, div.paddingTop, div.paddingLeft]).toEqual(["0.25", "3px", "5px"])
    expect(getComputedStyle(refs.label).paddingRight).toBe("6px")
    expect(app.renderer.getAttribute(refs.svg.nativeId, "viewBox")).toBe("0 0 1 1")
    expect(app.renderer.getAttribute(refs.svg.nativeId, "viewbox")).toBeNull()
    expect(getComputedStyle(refs.svg).opacity).toBe("0.5")
    expect(getComputedStyle(refs.svg).paddingTop).toBe("0px")

    app.flushSync(() => setTabIndex(-1))
    expect(getComputedStyle(refs.div).opacity).toBe("1")
    app.flushSync(() => setTabIndex(0))
    expect(getComputedStyle(refs.div).opacity).toBe("0.25")
  })

  it("class:name and classList give the element a class attribute, so a .name rule matches and getAttribute reads it", () => {
    let box: any
    const [active, setActive] = createSignal(false)
    app.render(() => (
      <>
        <style>{".active { opacity: 0.25 } .on { padding-top: 4px }"}</style>
        <div ref={(element: unknown) => (box = element)} class:active={active()} classList={{ on: true }} />
      </>
    ))
    const read = () => [app.renderer.getAttribute(box.nativeId, "class"), box.getAttribute("class"), box.className]
    expect(read()).toEqual(["on", "on", "on"])
    expect(getComputedStyle(box).opacity).toBe("1")
    expect(getComputedStyle(box).paddingTop).toBe("4px")

    app.flushSync(() => setActive(true))
    expect(read()).toEqual(["on active", "on active", "on active"])
    expect(getComputedStyle(box).opacity).toBe("0.25")

    app.flushSync(() => setActive(false))
    expect(read()).toEqual(["on", "on", "on"])
    expect(getComputedStyle(box).opacity).toBe("1")
  })

  it("adds the classList tokens to class, and only a key that was on takes its token away", () => {
    let box: any
    const [klass, setKlass] = createSignal<string | undefined>("a b")
    const [list, setList] = createSignal<Record<string, boolean>>({ c: true, a: false })
    app.render(() => (
      <>
        <style>{".c { opacity: 0.25 }"}</style>
        <div ref={(element: unknown) => (box = element)} class={klass()} classList={list()} />
      </>
    ))
    const read = () => app.renderer.getAttribute(box.nativeId, "class")
    // `a` was never on, so Solid's DOM leaves it where `class` put it.
    expect(read()).toBe("a b c")
    expect(getComputedStyle(box).opacity).toBe("0.25")

    app.flushSync(() => setList({ c: true, a: true }))
    expect(read()).toBe("a b c")
    app.flushSync(() => setList({ c: false, a: false }))
    expect(read()).toBe("b")
    expect(getComputedStyle(box).opacity).toBe("1")

    app.flushSync(() => setKlass(undefined))
    expect(read()).toBeNull()
    expect(box.getAttribute("class")).toBeNull()
  })

  it("lets class win over className, and className show again once class is undefined", () => {
    let box: any
    const [klass, setKlass] = createSignal<string | undefined>("a")
    app.render(() => (
      <>
        <style>{".a { opacity: 0.25 } .b { padding-top: 4px }"}</style>
        <div ref={(element: unknown) => (box = element)} class={klass()} {...{ className: "b" }} />
      </>
    ))
    const read = () => [app.renderer.getAttribute(box.nativeId, "class"), box.getAttribute("class"), box.className]
    expect(read()).toEqual(["a", "a", "a"])
    expect(getComputedStyle(box).paddingTop).toBe("0px")

    app.flushSync(() => setKlass(undefined))
    expect(read()).toEqual(["b", "b", "b"])
    expect(getComputedStyle(box).opacity).toBe("1")
    expect(getComputedStyle(box).paddingTop).toBe("4px")

    app.flushSync(() => setKlass("a"))
    expect(read()).toEqual(["a", "a", "a"])
  })
})
