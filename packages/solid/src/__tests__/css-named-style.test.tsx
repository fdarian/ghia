/**
 * Solid writes a `style` object's keys with `style.setProperty`, so a web Solid app's keys are CSS
 * property names (`'white-space'`, `'z-index'`, `'--gap'`). They take effect beside Ghia's camelCase keys.
 */
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { animate, motion, motionValue } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

type Handle = { nativeId: number }

const linear = { duration: 1, ease: "linear" } as const

describe.skipIf(!hasNativeTestRenderer)("Solid style keys written as CSS property names", () => {
  let app: ReturnType<typeof createTestRoot>

  afterEach(() => app.unmount())

  function nativeStyle(element: Element): Record<string, unknown> {
    app.renderer.flush()
    return app.renderer.getElement((element as unknown as Handle).nativeId)!.style as Record<string, unknown>
  }

  function mount(style: () => Record<string, unknown>): HTMLElement {
    app = createTestRoot()
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={style()} />)
    return box!
  }

  it("reads a hyphenated key as the property it names", () => {
    const box = mount(() => ({ position: "relative", "white-space": "nowrap", "z-index": 3, "padding-top": 7, "margin-left": "2px", opacity: 0.5 }))
    const style = nativeStyle(box)
    expect(style.whiteSpace).toBe("nowrap")
    expect(style).not.toHaveProperty("white-space")
    const computed = getComputedStyle(box)
    expect(computed.zIndex).toBe("3")
    expect(computed.paddingTop).toBe("7px")
    expect(computed.marginLeft).toBe("2px")
    expect(computed.opacity).toBe("0.5")
  })

  it("keeps camelCase keys, a mixed object, and the later of two keys for one property", () => {
    const box = mount(() => ({ paddingTop: 1, "padding-left": 2, "padding-top": 3, marginTop: 4, "margin-top": 5 }))
    const computed = getComputedStyle(box)
    expect(computed.paddingTop).toBe("3px")
    expect(computed.paddingLeft).toBe("2px")
    expect(computed.marginTop).toBe("5px")

    const reversed = mount(() => ({ "padding-top": 3, paddingTop: 1 }))
    expect(getComputedStyle(reversed).paddingTop).toBe("1px")
  })

  it("keeps a custom property's name and reads a vendor-prefixed one as its camelCase key", () => {
    const box = mount(() => ({ "--gap": "4px", "-webkit-font-smoothing": "antialiased" }))
    const style = nativeStyle(box)
    expect(style["--gap"]).toBe("4px")
    expect(style.WebkitFontSmoothing).toBe("antialiased")
    expect(getComputedStyle(box).getPropertyValue("--gap")).toBe("4px")
  })

  it("updates and removes a hyphenated key as a signal changes", () => {
    app = createTestRoot()
    const [style, setStyle] = createSignal<Record<string, unknown>>({ position: "relative", "padding-top": 5, "z-index": 2 })
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={style()} />)
    expect(getComputedStyle(box!).paddingTop).toBe("5px")

    app.flushSync(() => setStyle({ position: "relative", "padding-top": 9, "z-index": 2 }))
    expect(getComputedStyle(box!).paddingTop).toBe("9px")

    app.flushSync(() => setStyle({ position: "relative", "z-index": 2 }))
    expect(getComputedStyle(box!).paddingTop).toBe("0px")
    expect(getComputedStyle(box!).zIndex).toBe("2")

    app.flushSync(() => setStyle({ "padding-top": 4, "--gap": "1px" }))
    expect(getComputedStyle(box!).paddingTop).toBe("4px")
    expect(getComputedStyle(box!).getPropertyValue("--gap")).toBe("1px")
  })

  it("splits a motion value written under a hyphenated key from the style", () => {
    app = createTestRoot()
    app.renderer.clockPause()
    const padding = motionValue(0)
    app.render(() => (
      <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start" }}>
        <motion.div testId="box" style={{ "padding-left": padding, height: 10 }} />
      </div>
    ))
    animate(padding, 100, linear)
    app.renderer.clockFastForward(500)
    app.renderer.flush()
    app.renderer.dispatchNativeEvents()
    const element = app.renderer.findByTestId("box")!
    expect(app.renderer.getElementBounds(element.id)!.width).toBeCloseTo(50, 0)
    expect(padding.isAnimating()).toBe(true)
    expect(element.style).not.toHaveProperty("padding-left")
  })
})
