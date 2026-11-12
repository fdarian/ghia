import { afterEach, describe, expect, it, vi } from "vitest"
import * as classes from "../events/classes.js"
import { document, window as ghiaWindow } from "../events/window-target.js"
import "../dom-globals.js"
import { getComputedStyle } from "../computed-style.js"
import { matchMedia } from "../match-media.js"
import { IntersectionObserver } from "../observers.js"
import { Animation, CSSAnimation, CSSTransition, DocumentTimeline, KeyframeEffect } from "../web-animations.js"
import { createRendererState } from "../renderer-state.js"
import type { NativeRenderer } from "../host.js"
import { isWebBuild } from "../web-build.js"

describe("dom globals of the native build", () => {
  const listener = () => {}

  afterEach(() => {
    globalThis.removeEventListener("keydown", listener)
  })

  it("is not the web build", () => {
    expect(isWebBuild).toBe(false)
  })

  it("makes window the global object and document Ghia's document", () => {
    expect(typeof window).not.toBe("undefined")
    expect(window).toBe(globalThis)
    expect(globalThis.document).toBe(document)
    expect(window.document).toBe(document)
  })

  it("has requestAnimationFrame, cancelAnimationFrame and ResizeObserver, and a document whose view is the window", () => {
    expect(typeof globalThis.requestAnimationFrame).toBe("function")
    expect(typeof globalThis.cancelAnimationFrame).toBe("function")
    expect(typeof globalThis.ResizeObserver).toBe("function")
    expect(document.defaultView).toBe(globalThis)
  })

  it("turns scrolling the viewport into a no-op", () => {
    expect(window.scrollTo(0, 100)).toBeUndefined()
    expect(window.scroll({ top: 10 })).toBeUndefined()
    expect(window.scrollBy(0, 10)).toBeUndefined()
  })

  it("registers a global listener with Ghia's window, until it is removed", () => {
    expect(ghiaWindow.hasListeners("keydown")).toBe(false)
    globalThis.addEventListener("keydown", listener)
    expect(ghiaWindow.hasListeners("keydown")).toBe(true)
    globalThis.removeEventListener("keydown", listener)
    expect(ghiaWindow.hasListeners("keydown")).toBe(false)
  })

  it("installs once however often the module is evaluated", async () => {
    const add = globalThis.addEventListener
    vi.resetModules()
    await import("../dom-globals.js")
    expect(globalThis.addEventListener).toBe(add)
  })

  it("has getComputedStyle, matchMedia and IntersectionObserver as globals", () => {
    expect(globalThis.getComputedStyle).toBe(getComputedStyle)
    expect(globalThis.matchMedia).toBe(matchMedia)
    expect(globalThis.IntersectionObserver).toBe(IntersectionObserver)
  })

  it("has the Web Animations classes as globals, so a library's `instanceof KeyframeEffect` works", () => {
    expect(globalThis.KeyframeEffect).toBe(KeyframeEffect)
    expect(globalThis.Animation).toBe(Animation)
    expect(globalThis.CSSAnimation).toBe(CSSAnimation)
    expect(globalThis.CSSTransition).toBe(CSSTransition)
    expect(globalThis.DocumentTimeline).toBe(DocumentTimeline)
  })

  it("throws Illegal constructor when an app constructs a Web Animations class", () => {
    for (const Class of [KeyframeEffect, Animation, CSSAnimation, CSSTransition, DocumentTimeline]) {
      expect(() => Reflect.construct(Class, [])).toThrow(new TypeError("Illegal constructor"))
    }
  })

  it("keeps a global a runtime already has", async () => {
    const own = () => {}
    const before = Reflect.get(globalThis, "matchMedia")
    Reflect.set(globalThis, "matchMedia", own)
    Reflect.deleteProperty(globalThis, Symbol.for("@ghia/native/dom-globals"))
    try {
      vi.resetModules()
      await import("../dom-globals.js")
      expect(globalThis.matchMedia).toBe(own)
    } finally {
      Reflect.set(globalThis, "matchMedia", before)
    }
  })

  it("has frameElement, parent, top and self for a window that is no frame", () => {
    expect(window.frameElement).toBeNull()
    expect(window.parent).toBe(globalThis)
    expect(window.top).toBe(globalThis)
    expect(window.self).toBe(globalThis)
  })
})

class FakeWindow {
  width = 800
  height = 600
  mediaChangeCalls: boolean[] = []

  applyBatch(): number[] {
    return []
  }

  getWindowSize() {
    return { width: this.width, height: this.height }
  }

  setWindowMediaChange(enabled: boolean) {
    this.mediaChangeCalls.push(enabled)
  }

  /** What the renderer does for a resize, and for an OS preference change. */
  emitMediaChange() {
    createRendererState(this as unknown as NativeRenderer).dispatch({
      elementId: 0,
      eventType: "mediaChange",
      value: "resize",
    })
  }
}

describe("window size members", () => {
  const mounted: Array<{ detach(): boolean }> = []

  function mountWindow(): FakeWindow {
    const window = new FakeWindow()
    mounted.push(createRendererState(window as unknown as NativeRenderer).attach())
    return window
  }

  afterEach(() => {
    for (const binding of mounted.splice(0)) binding.detach()
  })

  it("throws before a root is mounted, as matchMedia does", () => {
    expect(() => window.innerWidth).toThrow(/mounted/)
    expect(() => window.innerHeight).toThrow(/mounted/)
    expect(() => window.visualViewport!.width).toThrow(/mounted/)
  })

  it("reads innerWidth and innerHeight live from the window that mounted last", () => {
    const first = mountWindow()
    const second = mountWindow()
    second.width = 300
    second.height = 200
    expect(window.innerWidth).toBe(300)
    expect(window.innerHeight).toBe(200)
    second.width = 450
    expect(window.innerWidth).toBe(450)
    mounted.pop()!.detach()
    expect(window.innerWidth).toBe(first.width)
  })

  it("has a visualViewport the size of the window, with no offset, scroll or zoom", () => {
    const fake = mountWindow()
    const viewport = window.visualViewport!
    expect(viewport.width).toBe(800)
    expect(viewport.height).toBe(600)
    fake.height = 480
    expect(viewport.height).toBe(480)
    expect([viewport.offsetLeft, viewport.offsetTop, viewport.pageLeft, viewport.pageTop]).toEqual([0, 0, 0, 0])
    expect(viewport.scale).toBe(1)
  })

  it("sends visualViewport a resize when the window size changes, not for another media change", () => {
    const fake = mountWindow()
    const viewport = window.visualViewport!
    const seen: Array<{ type: string; target: unknown; width: number }> = []
    const listener = (event: { type: string; target: unknown }) =>
      seen.push({ type: event.type, target: event.target, width: viewport.width })
    viewport.addEventListener("resize", listener)
    expect(fake.mediaChangeCalls).toEqual([true])
    fake.emitMediaChange()
    expect(seen).toEqual([])
    fake.width = 640
    fake.emitMediaChange()
    expect(seen).toEqual([{ type: "resize", target: viewport, width: 640 }])
    viewport.removeEventListener("resize", listener)
    expect(fake.mediaChangeCalls).toEqual([true, false])
    fake.width = 500
    fake.emitMediaChange()
    expect(seen.length).toBe(1)
  })
})

describe("event classes as globals", () => {
  it("installs the DOM event classes where the runtime has none, so a library can build events with them", () => {
    for (const name of Object.keys(classes.EVENT_CLASSES)) {
      expect(Reflect.get(globalThis, name)).toBe(classes.EVENT_CLASSES[name as keyof typeof classes.EVENT_CLASSES])
    }
    expect(window.PointerEvent).toBe(classes.PointerEvent)
    expect(document.defaultView?.PointerEvent).toBe(classes.PointerEvent)
  })
})
