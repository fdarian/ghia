/** A `<style>` element's text is a sheet native matches against the tree, so classes and attributes style elements. */
import React, { Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"
import { UniversalStyle } from "../index.js"

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

  it("lets an author keyword beat the user agent style: unset, initial and inherit win, revert gives it back", () => {
    const nodes: Record<string, any> = {}
    const ref = (name: string) => (element: unknown) => {
      nodes[name] = element
    }
    app.render(
      <div>
        <style>{`
          .unset { margin: unset }
          .initial { margin-block: initial }
          .revert { margin: revert }
          .inherit { font-weight: inherit }
          .inherit-margin { margin: inherit }
        `}</style>
        <p ref={ref("plain")} />
        <p ref={ref("unset")} className="unset" />
        <p ref={ref("initial")} className="initial" />
        <p ref={ref("revert")} className="revert" />
        <p ref={ref("inheritMargin")} className="inherit-margin" />
        <h1 ref={ref("h1")} />
        <h1 ref={ref("inherit")} className="inherit" />
        <p ref={ref("inline")} style={{ marginTop: "unset", marginBottom: "revert" }} />
      </div>
    )
    const margins = (name: string) => [getComputedStyle(nodes[name]).marginTop, getComputedStyle(nodes[name]).marginBottom]
    expect(margins("plain")).toEqual(["16px", "16px"])
    expect(margins("unset")).toEqual(["0px", "0px"])
    expect(margins("initial")).toEqual(["0px", "0px"])
    expect(margins("revert")).toEqual(["16px", "16px"])
    expect(margins("inheritMargin"), "inherit on a property that does not inherit is not read").toEqual(["16px", "16px"])
    expect(margins("inline")).toEqual(["0px", "16px"])
    const effective = (name: string) => app.renderer.getElement(nodes[name].nativeId)!.style
    expect(effective("h1")).toHaveProperty("fontWeight")
    expect(effective("inherit"), "the user agent's bold is taken back").not.toHaveProperty("fontWeight")
  })

  it("lets an author keyword beat the universal style", () => {
    const nodes: Record<string, any> = {}
    const ref = (name: string) => (element: unknown) => {
      nodes[name] = element
    }
    app.render(
      <div>
        <UniversalStyle style={{ opacity: 0.5, paddingTop: 4 }} />
        <style>{`.taken { opacity: unset; padding-top: initial }`}</style>
        <div ref={ref("taken")} className="taken" />
        <div ref={ref("kept")} />
      </div>
    )
    expect([getComputedStyle(nodes.taken).opacity, getComputedStyle(nodes.taken).paddingTop]).toEqual(["1", "0px"])
    expect([getComputedStyle(nodes.kept).opacity, getComputedStyle(nodes.kept).paddingTop]).toEqual(["0.5", "4px"])
  })
})
