/**
 * Several test renderers at once, on one native app: each has its own window, its own element ids
 * (two roots both have an element 1), events, media features, opened URLs and size, and disposing
 * one leaves the others open. The clipboard is the app's, as the system's is.
 */
import { describe, expect, it } from "vitest"
import { TestRenderer, encodeWireBatchForTest, hasNativeTestRenderer } from "../testing.js"
import type { EventPayload } from "../../index.js"

type Op = unknown[]

interface Window {
  renderer: TestRenderer
  events: EventPayload[]
}

const open = (width: number, height: number): Window => {
  const events: EventPayload[] = []
  const renderer = new TestRenderer({
    width,
    height,
    dispatchEvent: (event) => events.push(event),
    // Pointer events reach JS in the middle of the input, through the sync handler.
    dispatchSyncEvent: (event) => {
      events.push(event)
      return { defaultPrevented: false, propagationStopped: false }
    },
  })
  return { renderer, events }
}

const mount = (window: Window, box: { width: number; height: number }, label: string): void => {
  const ops: Op[] = [
    ["createElement", 1, "div"],
    ["setRoot", 1],
    ["setStyle", 1, { display: "flex", flexDirection: "column", alignItems: "flex-start" }],
    ["createElement", 2, "div"],
    ["appendChild", 1, 2],
    ["setStyle", 2, box],
    ["setEventListener", 2, "click", true],
    ["createElement", 3, "#text"],
    ["appendChild", 2, 3],
    ["setText", 3, label],
  ]
  window.renderer.applyBatch(encodeWireBatchForTest(ops))
  window.renderer.flush()
}

const clicks = (window: Window): number[] =>
  window.events.filter((event) => event.eventType === "click").map((event) => event.target)

describe.skipIf(!hasNativeTestRenderer)("several test renderers at once", () => {
  it("each applies its own batch, draws and reports its own bounds, under the same element ids", () => {
    const first = open(600, 400)
    const second = open(300, 500)
    mount(first, { width: 120, height: 40 }, "first window")
    mount(second, { width: 80, height: 90 }, "second window")

    expect(first.renderer.getElementBounds(2)).toMatchObject({ width: 120, height: 40 })
    expect(second.renderer.getElementBounds(2)).toMatchObject({ width: 80, height: 90 })
    expect(first.renderer.getPaintedText()).toEqual(["first window"])
    expect(second.renderer.getPaintedText()).toEqual(["second window"])
    expect(first.renderer.getWindowSize()).toEqual({ width: 600, height: 400 })
    expect(second.renderer.getWindowSize()).toEqual({ width: 300, height: 500 })
  })

  it("delivers an input to the window it was made on", () => {
    const first = open(400, 400)
    const second = open(400, 400)
    mount(first, { width: 100, height: 100 }, "a")
    mount(second, { width: 100, height: 100 }, "b")

    first.renderer.nativeSimulateClick(50, 50)
    expect(clicks(first)).toEqual([2])
    expect(clicks(second)).toEqual([])

    second.renderer.nativeSimulateClick(50, 50)
    second.renderer.nativeSimulateClick(50, 50)
    expect(clicks(first)).toEqual([2])
    expect(clicks(second)).toEqual([2, 2])
  })

  it("lets a handler of one window read the other's renderer", () => {
    const read: unknown[] = []
    const events: EventPayload[] = []
    const first = new TestRenderer({
      width: 400,
      height: 400,
      dispatchEvent: () => {},
      dispatchSyncEvent: (event) => {
        events.push(event)
        if (event.eventType === "click") read.push(second.renderer.getElementBounds(2), second.renderer.getWindowSize())
        return { defaultPrevented: false, propagationStopped: false }
      },
    })
    const second = open(250, 350)
    mount({ renderer: first, events }, { width: 100, height: 100 }, "a")
    mount(second, { width: 64, height: 48 }, "b")

    first.nativeSimulateClick(50, 50)
    expect(read).toMatchObject([{ width: 64, height: 48 }, { width: 250, height: 350 }])
  })

  /**
   * GPUI takes a window out of its slot while it updates it, so a read of window A from a handler that A's own input
   * set off in window B (A's click focuses B, B's `focus` listener reads A) finds A "not found". A is open then.
   */
  it("keeps a window open when a handler its input set off in another window reads it", () => {
    const heard: unknown[] = []
    const focusable = (window: Window): void => {
      mount(window, { width: 100, height: 100 }, "w")
      window.renderer.applyBatch(
        encodeWireBatchForTest([
          ["setCustomProp", 2, "tabIndex", 0],
          ["setEventListener", 2, "focus", true],
        ])
      )
      window.renderer.flush()
    }
    const first = new TestRenderer({
      width: 400,
      height: 400,
      dispatchEvent: () => {},
      dispatchSyncEvent: (event) => {
        if (event.eventType === "click") second.focusElement(2)
        return { defaultPrevented: false, propagationStopped: false }
      },
    })
    const second = new TestRenderer({
      width: 300,
      height: 300,
      dispatchEvent: () => {},
      dispatchSyncEvent: (event) => {
        if (event.eventType === "focus") {
          try {
            heard.push(first.getElementBounds(2))
          } catch (error) {
            heard.push(String(error))
          }
        }
        return { defaultPrevented: false, propagationStopped: false }
      },
    })
    focusable({ renderer: first, events: [] })
    focusable({ renderer: second, events: [] })

    first.nativeSimulateClick(50, 50)

    expect(heard).toHaveLength(1)
    // The read works or says why it cannot; it never calls the window gone.
    expect(typeof heard[0] === "string" ? heard[0] : "").not.toMatch(/window not found|is closed/)
    expect(first.isWindowClosed()).toBe(false)
    expect(second.isWindowClosed()).toBe(false)
    first.applyBatch(encodeWireBatchForTest([["setText", 3, "after"]]))
    first.flush()
    expect(first.getPaintedText()).toEqual(["after"])
    first.dispose()
    second.dispose()
    expect(first.isWindowClosed()).toBe(true)
  })

  it("draws a window only when asked: a frame of one is not a frame of the other", () => {
    const first = open(400, 400)
    const second = open(400, 400)
    mount(first, { width: 100, height: 100 }, "before")
    mount(second, { width: 100, height: 100 }, "before")

    second.renderer.applyBatch(encodeWireBatchForTest([["setText", 3, "after"]]))
    const frames = [first.renderer.getPaintedFrameCount(), second.renderer.getPaintedFrameCount()]
    first.renderer.flush()
    expect(first.renderer.getPaintedFrameCount()).toBeGreaterThan(frames[0])
    expect(second.renderer.getPaintedFrameCount()).toBe(frames[1])
    second.renderer.flush()
    expect(second.renderer.getPaintedFrameCount()).toBeGreaterThan(frames[1])
    expect(second.renderer.getPaintedText()).toEqual(["after"])
    expect(first.renderer.getPaintedText()).toEqual(["before"])
  })

  it("keeps a window's size, media features and opened URLs to itself", () => {
    const first = open(400, 400)
    const second = open(400, 400)

    first.renderer.setWindowSize(500, 300)
    expect(first.renderer.getWindowSize()).toEqual({ width: 500, height: 300 })
    expect(second.renderer.getWindowSize()).toEqual({ width: 400, height: 400 })

    first.renderer.setMediaFeatures({ reducedMotion: true })
    expect(first.renderer.getMediaFeatures().reducedMotion).toBe(true)
    expect(second.renderer.getMediaFeatures().reducedMotion).toBe(false)

    second.renderer.openUrl("https://example.test/second")
    expect(first.renderer.openedUrls()).toEqual([])
    expect(second.renderer.openedUrls()).toEqual(["https://example.test/second"])
  })

  it("shares the clipboard, which is the app's", () => {
    const first = open(200, 200)
    const second = open(200, 200)
    first.renderer.writeClipboard([{ type: "text/plain", data: "copied in the first" }])
    expect(second.renderer.readClipboard()).toEqual([{ type: "text/plain", data: "copied in the first" }])
  })

  it("leaves the other windows working when one is disposed, and takes a new one after", () => {
    const first = open(400, 400)
    const second = open(400, 400)
    mount(first, { width: 100, height: 100 }, "first")
    mount(second, { width: 70, height: 70 }, "second")

    first.renderer.dispose()
    expect(() => first.renderer.flush()).toThrow()
    expect(second.renderer.getElementBounds(2)).toMatchObject({ width: 70, height: 70 })
    second.renderer.nativeSimulateClick(20, 20)
    expect(clicks(second)).toEqual([2])

    const third = open(400, 400)
    mount(third, { width: 30, height: 30 }, "third")
    expect(third.renderer.getElementBounds(2)).toMatchObject({ width: 30, height: 30 })
    expect(second.renderer.getElementBounds(2)).toMatchObject({ width: 70, height: 70 })
    expect(third.renderer.getPaintedText()).toEqual(["third"])

    second.renderer.dispose()
    third.renderer.dispose()
  })

  it("takes a window again once every one was disposed", () => {
    const first = open(400, 400)
    mount(first, { width: 50, height: 50 }, "one")
    first.renderer.dispose()

    const second = open(400, 400)
    mount(second, { width: 60, height: 60 }, "two")
    expect(second.renderer.getElementBounds(2)).toMatchObject({ width: 60, height: 60 })
    second.renderer.dispose()
  })

  it("a window that was disposed twice, or after its app went, stays disposed", () => {
    const first = open(200, 200)
    const second = open(200, 200)
    first.renderer.dispose()
    first.renderer.dispose()
    second.renderer.dispose()
    second.renderer.dispose()
    expect(() => second.renderer.flush()).toThrow()
  })
})
