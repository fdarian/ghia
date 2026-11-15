/**
 * solid-js types `style` as `CSSProperties | string`, and Solid on the web writes a string with
 * `style.cssText`: it replaces the whole style, `""` and `undefined` remove the attribute, and an
 * object after a string starts from nothing.
 */
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

type Handle = { nativeId: number }

describe.skipIf(!hasNativeTestRenderer)("Solid string style", () => {
  let app: ReturnType<typeof createTestRoot>

  afterEach(() => app.unmount())

  function nativeStyle(element: Element): Record<string, unknown> {
    app.renderer.flush()
    return app.renderer.getElement((element as unknown as Handle).nativeId)!.style as Record<string, unknown>
  }

  it("is the declarations of the text, as style.cssText would leave them", () => {
    app = createTestRoot()
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style="position: relative; padding-top: 7px; white-space: nowrap; z-index: 3; bogus; --gap: 4px" />)
    expect(nativeStyle(box!)).toEqual({ position: "relative", paddingTop: 7, whiteSpace: "nowrap", zIndex: 3, "--gap": "4px" })
    expect(box!.getAttribute("style")).toBe("position: relative; padding-top: 7px; white-space: nowrap; z-index: 3; --gap: 4px;")
    expect(box!.style.paddingTop).toBe("7px")
  })

  it("replaces the previous string, and goes to an object, to nothing and back as the web does", () => {
    app = createTestRoot()
    const [style, setStyle] = createSignal<string | Record<string, unknown> | undefined>("color: red; padding-top: 4px")
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={style()} />)
    expect(nativeStyle(box!)).toMatchObject({ color: "red", paddingTop: 4 })

    app.flushSync(() => setStyle("padding-left: 2px"))
    expect(nativeStyle(box!)).toEqual({ paddingLeft: 2 })

    app.flushSync(() => setStyle({ "margin-top": 5, color: "blue" }))
    expect(nativeStyle(box!)).toEqual({ marginTop: 5, color: "blue" })

    app.flushSync(() => setStyle("width: 9px"))
    expect(nativeStyle(box!)).toEqual({ width: 9 })

    app.flushSync(() => setStyle(undefined))
    expect(nativeStyle(box!)).toEqual({})
    expect(box!.getAttribute("style")).toBeNull()

    app.flushSync(() => setStyle("height: 3px"))
    expect(nativeStyle(box!)).toEqual({ height: 3 })

    app.flushSync(() => setStyle(""))
    expect(nativeStyle(box!)).toEqual({})
    expect(box!.getAttribute("style")).toBeNull()
  })

  it("keeps what code wrote through element.style when the string changes, as an object does", () => {
    app = createTestRoot()
    const [style, setStyle] = createSignal("color: red")
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={style()} />)
    box!.style.setProperty("margin-top", "3px")
    app.flushSync(() => setStyle("padding-top: 1px"))
    expect(nativeStyle(box!)).toEqual({ marginTop: 3, paddingTop: 1 })
  })
})
