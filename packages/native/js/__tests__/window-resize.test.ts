/// `window` and `visualViewport` `resize`. Its own file: the module-reset test of dom-globals installs the
/// globals twice, and a global `addEventListener` then reaches both copies of the window.
import { afterEach, describe, expect, it } from "vitest"
import "../dom-globals.js"
import { createRendererState } from "../renderer-state.js"
import type { NativeRenderer } from "../host.js"

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

describe("the resize event", () => {
  const mounted: Array<{ detach(): boolean }> = []

  function mountWindow(): FakeWindow {
    const window = new FakeWindow()
    mounted.push(createRendererState(window as unknown as NativeRenderer).attach())
    return window
  }

  afterEach(() => {
    for (const binding of mounted.splice(0)) binding.detach()
  })

  it("sends window a resize, target the window, when the window size changes", () => {
    const fake = mountWindow()
    const seen: Array<{ type: string; target: unknown; width: number }> = []
    const listener = (event: { type: string; target: unknown; currentTarget: unknown }) => {
      expect(event.currentTarget).toBe(window)
      seen.push({ type: event.type, target: event.target, width: window.innerWidth })
    }
    window.addEventListener("resize", listener)
    expect(fake.mediaChangeCalls).toEqual([true])
    fake.emitMediaChange()
    expect(seen).toEqual([])
    fake.height = 400
    fake.emitMediaChange()
    expect(seen).toEqual([{ type: "resize", target: globalThis, width: 800 }])
    window.removeEventListener("resize", listener)
    expect(fake.mediaChangeCalls).toEqual([true, false])
    fake.height = 300
    fake.emitMediaChange()
    expect(seen.length).toBe(1)
  })

  it("shares one subscription between window and visualViewport, visualViewport first", () => {
    const fake = mountWindow()
    const order: string[] = []
    const onWindow = () => order.push("window")
    const onViewport = (event: { currentTarget: unknown }) => {
      expect(event.currentTarget).toBe(window.visualViewport)
      order.push("visualViewport")
    }
    window.addEventListener("resize", onWindow)
    window.visualViewport!.addEventListener("resize", onViewport)
    expect(fake.mediaChangeCalls).toEqual([true])
    fake.width = 500
    fake.emitMediaChange()
    expect(order).toEqual(["visualViewport", "window"])
    window.removeEventListener("resize", onWindow)
    expect(fake.mediaChangeCalls).toEqual([true])
    window.visualViewport!.removeEventListener("resize", onViewport)
    expect(fake.mediaChangeCalls).toEqual([true, false])
  })

  it("starts watching a window that mounts after the listener was added, and follows the last one", () => {
    const seen: number[] = []
    const listener = () => seen.push(window.innerWidth)
    window.addEventListener("resize", listener)
    try {
      const first = mountWindow()
      expect(first.mediaChangeCalls).toEqual([true])
      first.width = 700
      first.emitMediaChange()
      const second = mountWindow()
      expect(first.mediaChangeCalls).toEqual([true, false])
      expect(second.mediaChangeCalls).toEqual([true])
      first.width = 710
      first.emitMediaChange()
      second.width = 900
      second.emitMediaChange()
      mounted.pop()!.detach()
      expect(second.mediaChangeCalls).toEqual([true, false])
      expect(first.mediaChangeCalls).toEqual([true, false, true])
      expect(seen).toEqual([700, 900])
    } finally {
      window.removeEventListener("resize", listener)
    }
  })

  it("lets visualViewport take a resize listener before a root mounts, and starts at the first mount", () => {
    const seen: number[] = []
    const listener = () => seen.push(window.visualViewport!.width)
    window.visualViewport!.addEventListener("resize", listener)
    try {
      expect(() => window.visualViewport!.width).toThrow(/mounted/)
      const fake = mountWindow()
      expect(fake.mediaChangeCalls).toEqual([true])
      fake.width = 640
      fake.emitMediaChange()
      expect(seen).toEqual([640])
    } finally {
      window.visualViewport!.removeEventListener("resize", listener)
    }
  })

  it("stops after a once listener has run", () => {
    const fake = mountWindow()
    let calls = 0
    window.addEventListener("resize", () => calls++, { once: true })
    fake.width = 100
    fake.emitMediaChange()
    fake.width = 200
    fake.emitMediaChange()
    expect(calls).toBe(1)
    expect(fake.mediaChangeCalls).toEqual([true, false])
  })
})
