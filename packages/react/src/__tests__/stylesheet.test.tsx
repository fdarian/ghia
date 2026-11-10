/** A `<style>` element's text is a sheet native matches against the tree, so classes and attributes style elements. */
import React from "react"
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
})
