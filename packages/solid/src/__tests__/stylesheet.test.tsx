/** A `<style>` element's text is a sheet native matches against the tree, so classes and attributes style elements. */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { For, createSignal } from "solid-js"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { UniversalStyle } from "../components/universal-style.js"

describe.skipIf(!hasNativeTestRenderer)("stylesheets in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  it("styles elements by tag, class and id, over nothing and under an important rule", () => {
    let plain: any
    let card: any
    let inline: any
    app.render(() => (
      <div>
        <style>{`
          .card { opacity: 0.5; padding-top: 4px }
          #lone { padding-left: 3px }
          .card.big { padding-top: 9px !important }
        `}</style>
        <div ref={(element: unknown) => (plain = element)} />
        <div ref={(element: unknown) => (card = element)} class="card big" />
        <div ref={(element: unknown) => (inline = element)} id="lone" class="card" style={{ opacity: 0.9, paddingTop: 1 }} />
      </div>
    ))
    expect(getComputedStyle(plain).opacity).toBe("1")
    expect(getComputedStyle(card).opacity).toBe("0.5")
    expect(getComputedStyle(card).paddingTop).toBe("9px")
    expect(getComputedStyle(inline).paddingLeft).toBe("3px")
    expect(getComputedStyle(inline).opacity).toBe("0.9")
    expect(getComputedStyle(inline).paddingTop).toBe("1px")
  })

  it("reads a custom property a sheet sets, and the var() it resolves, in getComputedStyle", () => {
    let parent: any
    let child: any
    app.render(() => (
      <div>
        <style>{`.theme { --gap: 12px } .theme > .row { padding-top: var(--gap); opacity: 0.5 }`}</style>
        <div ref={(element: unknown) => (parent = element)} class="theme">
          <div ref={(element: unknown) => (child = element)} class="row" />
        </div>
      </div>
    ))
    expect(getComputedStyle(parent).getPropertyValue("--gap")).toBe("12px")
    expect(getComputedStyle(child).getPropertyValue("--gap")).toBe("12px")
    expect(getComputedStyle(child).paddingTop).toBe("12px")
    expect(getComputedStyle(child).opacity).toBe("0.5")
  })

  it("matches again when a class or a data attribute toggles", () => {
    let box: any
    let child: any
    const [on, setOn] = createSignal(false)
    const [theme, setTheme] = createSignal<string | undefined>(undefined)
    app.render(() => (
      <div>
        <style>{`.on { opacity: 0.25 } [data-theme=dark] .child { padding-top: 6px }`}</style>
        <div ref={(element: unknown) => (box = element)} class={on() ? "on" : undefined} data-theme={theme()}>
          <div ref={(element: unknown) => (child = element)} class="child" />
        </div>
      </div>
    ))
    expect(getComputedStyle(box).opacity).toBe("1")
    expect(getComputedStyle(child).paddingTop).toBe("0px")

    app.flushSync(() => setOn(true))
    expect(getComputedStyle(box).opacity).toBe("0.25")

    app.flushSync(() => setTheme("dark"))
    expect(getComputedStyle(child).paddingTop).toBe("6px")

    app.flushSync(() => {
      setOn(false)
      setTheme(undefined)
    })
    expect(getComputedStyle(box).opacity).toBe("1")
    expect(getComputedStyle(child).paddingTop).toBe("0px")
  })

  it("matches one element again when a class toggles on one of fifty items", () => {
    const [active, setActive] = createSignal(-1)
    const items: unknown[] = []
    app.render(() => (
      <div>
        <style>{`.on { opacity: 0.25 } .item { padding-top: 2px }`}</style>
        <For each={Array.from({ length: 50 }, (_, index) => index)}>
          {(index) => <div ref={(element: unknown) => (items[index] = element)} class={active() === index ? "item on" : "item"} />}
        </For>
      </div>
    ))
    app.renderer.resetBuildCounters()
    app.flushSync(() => setActive(7))
    expect(getComputedStyle(items[7] as any).opacity).toBe("0.25")
    expect(app.renderer.getBuildCounters().elementsRematched).toBe(1)

    app.renderer.resetBuildCounters()
    app.flushSync(() => setActive(8))
    expect(getComputedStyle(items[7] as any).opacity).toBe("1")
    expect(getComputedStyle(items[8] as any).opacity).toBe("0.25")
    expect(app.renderer.getBuildCounters().elementsRematched).toBe(2)
  })

  it("follows the text of the style element and its removal", () => {
    let box: any
    const [css, setCss] = createSignal(".a { opacity: 0.5 }")
    const [shown, setShown] = createSignal(true)
    app.render(() => (
      <div>
        {shown() && <style>{css()}</style>}
        <div ref={(element: unknown) => (box = element)} class="a" />
      </div>
    ))
    expect(getComputedStyle(box).opacity).toBe("0.5")
    app.flushSync(() => setCss(".a { opacity: 0.75 }"))
    expect(getComputedStyle(box).opacity).toBe("0.75")
    app.flushSync(() => setShown(false))
    expect(getComputedStyle(box).opacity).toBe("1")
  })

  it("stacks the user agent style of a tag, `*`, a rule, the inline style and the important ones of both", () => {
    let mark: any
    const [css, setCss] = createSignal(".a { color: rgb(255, 0, 0) }")
    const [inline, setInline] = createSignal<Record<string, string> | undefined>(undefined)
    app.render(() => (
      <div>
        <UniversalStyle style={{ color: "rgb(0, 0, 17)" }} />
        <style>{css()}</style>
        <mark ref={(element: unknown) => (mark = element)} class="a" style={inline()} />
      </div>
    ))
    expect(getComputedStyle(mark).backgroundColor).toBe("rgb(255, 255, 0)")
    expect(getComputedStyle(mark).color).toBe("rgb(255, 0, 0)")

    app.flushSync(() => setInline({ color: "rgb(0, 128, 0)" }))
    expect(getComputedStyle(mark).color).toBe("rgb(0, 128, 0)")

    app.flushSync(() => setCss(".a { color: rgb(0, 0, 255) !important }"))
    expect(getComputedStyle(mark).color).toBe("rgb(0, 0, 255)")

    app.flushSync(() => setInline({ color: "rgb(128, 0, 128) !important" }))
    expect(getComputedStyle(mark).color).toBe("rgb(128, 0, 128)")
    expect(getComputedStyle(mark).backgroundColor).toBe("rgb(255, 255, 0)")
  })

  it("lets a rule beat the user agent style of a tag, and `*` beat it too", () => {
    let heading: any
    let paragraph: any
    let button: any
    app.render(() => (
      <div>
        <UniversalStyle style={{ marginBottom: 7 }} />
        <style>{`h1 { margin-top: 3px } button { display: flex }`}</style>
        <h1 ref={(element: unknown) => (heading = element)} />
        <p ref={(element: unknown) => (paragraph = element)} />
        <button ref={(element: unknown) => (button = element)} />
      </div>
    ))
    expect(getComputedStyle(heading).marginTop).toBe("3px")
    expect(getComputedStyle(heading).marginBottom).toBe("7px")
    expect(getComputedStyle(heading).display).toBe("block")
    expect(getComputedStyle(paragraph).marginTop).toBe("16px")
    expect(getComputedStyle(paragraph).marginBottom).toBe("7px")
    expect(getComputedStyle(button).display).toBe("flex")
  })

  it("matches a type selector against the tag of an HTML element", () => {
    const refs: Record<string, any> = {}
    app.render(() => (
      <div>
        <style>{`p, button, a, h2, ul, li { opacity: 0.25 }`}</style>
        <p ref={(element: unknown) => (refs.p = element)} />
        <button ref={(element: unknown) => (refs.button = element)} />
        <a ref={(element: unknown) => (refs.a = element)} />
        <h2 ref={(element: unknown) => (refs.h2 = element)} />
        <ul ref={(element: unknown) => (refs.ul = element)}>
          <li ref={(element: unknown) => (refs.li = element)} />
        </ul>
        <div ref={(element: unknown) => (refs.div = element)} />
      </div>
    ))
    for (const tag of ["p", "button", "a", "h2", "ul", "li"]) expect(getComputedStyle(refs[tag]).opacity, tag).toBe("0.25")
    expect(getComputedStyle(refs.div).opacity).toBe("1")
  })

  it("lets a sheet restyle body, and `[style]` does not match html, head or body", () => {
    let marked: any
    app.render(() => (
      <div ref={(element: unknown) => (marked = element)} style={{ width: 10 }}>
        <style>{`body { display: flex } [style] { opacity: 0.3 }`}</style>
      </div>
    ))
    const body = document.body!
    expect(getComputedStyle(body).display).toBe("flex")
    expect(getComputedStyle(body).width).not.toBe("")
    expect(getComputedStyle(document.head!).display).toBe("none")
    expect(getComputedStyle(body).opacity).toBe("1")
    expect(getComputedStyle(document.documentElement!).opacity).toBe("1")
    expect(getComputedStyle(document.documentElement!).display).toBe("block")
    expect(getComputedStyle(marked).opacity).toBe("0.3")
    expect(body.hasAttribute("style")).toBe(false)
  })

  it("makes an inline `!important` written through element.style win over a sheet's, on every write path", () => {
    const refs: Record<string, any> = {}
    app.render(() => (
      <div>
        <style>{`.x { display: block !important }`}</style>
        <div
          ref={(element: unknown) => {
            refs.box = element
          }}
          class="x"
        />
      </div>
    ))
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
    app.render(() => (
      <div>
        <style>{`.x { display: block !important }`}</style>
        <div
          ref={(element: unknown) => {
            refs.box = element
          }}
          class="x"
          style={{ display: "none !important", width: 30 }}
        />
      </div>
    ))
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
