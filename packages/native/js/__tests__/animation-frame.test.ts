import { afterEach, describe, expect, it, vi } from "vitest"
import {
  addFrameSource,
  cancelAnimationFrame,
  requestAnimationFrame,
  resumeFrameRequests,
  runAnimationFrame,
  type FrameSource,
} from "../animation-frame.js"

/** A window that records how often it was asked, and takes the request when it is open. */
const report = (error: unknown) => {
  throw error
}

function windowSource(open = true) {
  const state = { open, asks: 0 }
  const source: FrameSource = {
    requestAnimationFrame() {
      state.asks++
      return state.open
    },
  }
  return { state, source }
}

describe("requestAnimationFrame", () => {
  const stops: Array<() => void> = []
  const add = (source: FrameSource) => {
    const stop = addFrameSource(source)
    stops.push(stop)
    return stop
  }

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    // Leaves nothing queued for the next test.
    runAnimationFrame({}, 0, () => {})
  })

  it("asks each window once until its frame runs", () => {
    const first = windowSource()
    const second = windowSource()
    add(first.source)
    add(second.source)
    requestAnimationFrame(() => {})
    requestAnimationFrame(() => {})
    expect([first.state.asks, second.state.asks]).toEqual([1, 1])
    runAnimationFrame(first.source, 0, report)
    requestAnimationFrame(() => {})
    expect([first.state.asks, second.state.asks]).toEqual([2, 1])
  })

  it("runs the callbacks in order with one time, and a second window finds nothing left", () => {
    const first = windowSource()
    const second = windowSource()
    add(first.source)
    add(second.source)
    const seen: Array<[string, number]> = []
    requestAnimationFrame((time) => seen.push(["a", time]))
    requestAnimationFrame((time) => seen.push(["b", time]))
    runAnimationFrame(first.source, 1234.5, report)
    runAnimationFrame(second.source, 9999, report)
    expect(seen).toEqual([["a", 1234.5], ["b", 1234.5]])
  })

  it("keeps what a callback requests for the next frame", () => {
    add(windowSource().source)
    const source = windowSource().source
    add(source)
    const order: string[] = []
    requestAnimationFrame(() => {
      order.push("first")
      requestAnimationFrame(() => order.push("nested"))
    })
    runAnimationFrame(source, 0, report)
    expect(order).toEqual(["first"])
    runAnimationFrame(source, 0, report)
    expect(order).toEqual(["first", "nested"])
  })

  it("does not run a cancelled callback, one of the running frame included", () => {
    const source = windowSource().source
    add(source)
    const order: string[] = []
    const cancelled = requestAnimationFrame(() => order.push("cancelled"))
    let later = 0
    requestAnimationFrame(() => {
      order.push("first")
      cancelAnimationFrame(later)
    })
    later = requestAnimationFrame(() => order.push("later"))
    cancelAnimationFrame(cancelled)
    runAnimationFrame(source, 0, report)
    expect(order).toEqual(["first"])
  })

  it("reports a callback that throws to the reporter and runs the rest", () => {
    const source = windowSource().source
    add(source)
    const reported: unknown[] = []
    const order: string[] = []
    const boom = new Error("boom")
    requestAnimationFrame(() => {
      throw boom
    })
    requestAnimationFrame(() => order.push("after"))
    runAnimationFrame(source, 0, (error) => reported.push(error))
    expect(order).toEqual(["after"])
    expect(reported).toEqual([boom])
  })

  it("does not throw when the window refuses the request, and runs the callback in a later frame", () => {
    const source: FrameSource = {
      requestAnimationFrame() {
        throw new Error("no window")
      },
    }
    add(source)
    const order: string[] = []
    expect(() => requestAnimationFrame(() => order.push("ran"))).not.toThrow()
    expect(order).toEqual([])
    runAnimationFrame(source, 0, report)
    expect(order).toEqual(["ran"])
  })

  it("asks a window that attaches after a refused request", () => {
    const refusing: FrameSource = {
      requestAnimationFrame() {
        throw new Error("no window")
      },
    }
    add(refusing)
    const order: string[] = []
    requestAnimationFrame(() => order.push("ran"))
    const later = windowSource()
    add(later.source)
    expect(later.state.asks).toBe(1)
    runAnimationFrame(later.source, 0, report)
    expect(order).toEqual(["ran"])
  })

  it("waits for the first window, and asks again once a window that was not open takes requests", () => {
    const order: string[] = []
    requestAnimationFrame(() => order.push("waited"))
    const closed = windowSource(false)
    add(closed.source)
    expect(closed.state.asks).toBe(1)
    closed.state.open = true
    resumeFrameRequests(closed.source)
    expect(closed.state.asks).toBe(2)
    runAnimationFrame(closed.source, 0, report)
    expect(order).toEqual(["waited"])
  })

  it("stops asking a window that was taken out", () => {
    const gone = windowSource()
    const stop = add(gone.source)
    stop()
    requestAnimationFrame(() => {})
    expect(gone.state.asks).toBe(0)
  })
})
