/** A `<style>` element's text is a sheet native matches against the tree, so classes and attributes style elements. */
import React, { Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("stylesheets in React", () => {
  let app: TestRoot

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  it("styles elements by tag, class and id, over nothing and under an important rule", () => {
    const refs: Record<string, any> = {}
    const ref = (name: string) => (element: unknown) => {
      refs[name] = element
    }
    app.render(
      <div>
        <style>{`
          .card { opacity: 0.5; padding-top: 4px }
          #lone { padding-left: 3px }
          .card.big { padding-top: 9px !important }
        `}</style>
        <div ref={ref("plain")} />
        <div ref={ref("card")} className="card big" />
        <div ref={ref("inline")} id="lone" className="card" style={{ opacity: 0.9, paddingTop: 1 }} />
      </div>
    )
    expect(getComputedStyle(refs.plain).opacity).toBe("1")
    expect(getComputedStyle(refs.card).opacity).toBe("0.5")
    expect(getComputedStyle(refs.card).paddingTop).toBe("9px")
    expect(getComputedStyle(refs.inline).paddingLeft).toBe("3px")
    expect(getComputedStyle(refs.inline).opacity).toBe("0.9")
    expect(getComputedStyle(refs.inline).paddingTop).toBe("1px")
  })

  it("keeps an element Suspense hid hidden under a rule that sets its display", () => {
    const refs: Record<string, any> = {}
    const pending = new Promise<never>(() => {})
    function Maybe(props: { suspend: boolean }) {
      if (props.suspend) throw pending
      return null
    }
    const view = (suspend: boolean) => (
      <div>
        <style>{`.shown { display: flex !important }`}</style>
        <Suspense fallback={<div>fallback</div>}>
          <div
            ref={(element: unknown) => {
              // React clears the ref while it hides the element.
              refs.hidden ??= element
            }}
            className="shown"
            style={{ display: "block" }}
          />
          <Maybe suspend={suspend} />
        </Suspense>
      </div>
    )
    app.render(view(false))
    expect(getComputedStyle(refs.hidden).display).toBe("flex")
    app.render(view(true))
    expect(getComputedStyle(refs.hidden).display).toBe("none")
  })

  it("matches again when a class or a data attribute toggles", () => {
    const refs: Record<string, any> = {}
    const view = (on: boolean, theme?: string) => (
      <div>
        <style>{`.on { opacity: 0.25 } [data-theme=dark] .child { padding-top: 6px }`}</style>
        <div
          ref={(element: unknown) => {
            refs.box = element
          }}
          className={on ? "on" : undefined}
          data-theme={theme}
        >
          <div
            ref={(element: unknown) => {
              refs.child = element
            }}
            className="child"
          />
        </div>
      </div>
    )
    app.render(view(false))
    expect(getComputedStyle(refs.box).opacity).toBe("1")
    expect(getComputedStyle(refs.child).paddingTop).toBe("0px")

    app.render(view(true))
    expect(getComputedStyle(refs.box).opacity).toBe("0.25")

    app.render(view(true, "dark"))
    expect(getComputedStyle(refs.child).paddingTop).toBe("6px")

    app.render(view(false))
    expect(getComputedStyle(refs.box).opacity).toBe("1")
    expect(getComputedStyle(refs.child).paddingTop).toBe("0px")
  })

  it("follows the text of the style element and its removal", () => {
    const refs: Record<string, any> = {}
    const view = (css: string | null) => (
      <div>
        {css !== null && <style>{css}</style>}
        <div
          ref={(element: unknown) => {
            refs.box = element
          }}
          className="a"
        />
      </div>
    )
    app.render(view(".a { opacity: 0.5 }"))
    expect(getComputedStyle(refs.box).opacity).toBe("0.5")
    app.render(view(".a { opacity: 0.75 }"))
    expect(getComputedStyle(refs.box).opacity).toBe("0.75")
    app.render(view(null))
    expect(getComputedStyle(refs.box).opacity).toBe("1")
  })

  it("makes an inline `!important` written through element.style win over a sheet's, on every write path", () => {
    const refs: Record<string, any> = {}
    app.render(
      <div>
        <style>{`.x { display: block !important }`}</style>
        <div
          ref={(element: unknown) => {
            refs.box = element
          }}
          className="x"
        />
      </div>
    )
    const style = refs.box.style
    expect(getComputedStyle(refs.box).display).toBe("block")

    style.setProperty("display", "none", "important")
    expect(getComputedStyle(refs.box).display).toBe("none")
    expect(style.display).toBe("none")
    expect(style.getPropertyValue("display")).toBe("none")
    expect(style.getPropertyPriority("display")).toBe("important")
    expect(style.cssText).toBe("display: none !important;")
    expect(refs.box.getAttribute("style")).toBe("display: none !important;")

    style.setProperty("display", "none")
    expect(getComputedStyle(refs.box).display).toBe("block")
    expect(style.getPropertyPriority("display")).toBe("")

    style.cssText = "display: none !important"
    expect(getComputedStyle(refs.box).display).toBe("none")
    style.cssText = ""
    expect(getComputedStyle(refs.box).display).toBe("block")

    refs.box.setAttribute("style", "display:none !important")
    expect(getComputedStyle(refs.box).display).toBe("none")
    expect(style.getPropertyPriority("display")).toBe("important")
    refs.box.removeAttribute("style")
    expect(getComputedStyle(refs.box).display).toBe("block")

    style.setProperty("display", "none", "important")
    expect(style.removeProperty("display")).toBe("none")
    expect(getComputedStyle(refs.box).display).toBe("block")
  })

  it("reads a framework's `x !important` value as the value with the priority, and round-trips cssText", () => {
    const refs: Record<string, any> = {}
    app.render(
      <div>
        <style>{`.x { display: block !important }`}</style>
        <div
          ref={(element: unknown) => {
            refs.box = element
          }}
          className="x"
          style={{ display: "none !important", width: 30 }}
        />
      </div>
    )
    const style = refs.box.style
    expect(getComputedStyle(refs.box).display).toBe("none")
    expect(style.display).toBe("none")
    expect(style.getPropertyValue("display")).toBe("none")
    expect(style.getPropertyPriority("display")).toBe("important")
    expect(style.getPropertyPriority("width")).toBe("")
    expect(style.cssText).toBe("display: none !important; width: 30px;")

    const text = style.cssText
    style.cssText = text
    expect(style.cssText).toBe(text)
    expect(getComputedStyle(refs.box).display).toBe("none")
    expect(style.removeProperty("display")).toBe("none")
    expect(getComputedStyle(refs.box).display).toBe("block")
  })
})
