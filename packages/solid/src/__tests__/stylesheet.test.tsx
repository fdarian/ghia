/** A `<style>` element's text is a sheet native matches against the tree, so classes and attributes style elements. */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { For, createSignal } from "solid-js"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

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
})
