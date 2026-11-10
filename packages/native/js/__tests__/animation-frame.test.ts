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
    runAnimationFrame({})
  })

  it("asks each window once until its frame runs", () => {
    const first = windowSource()
    const second = windowSource()
    add(first.source)
    add(second.source)
    requestAnimationFrame(() => {})
    requestAnimationFrame(() => {})
    expect([first.state.asks, second.state.asks]).toEqual([1, 1])
    runAnimationFrame(first.source)
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
    runAnimationFrame(first.source)
    runAnimationFrame(second.source)
    expect(seen.map(([name]) => name)).toEqual(["a", "b"])
    expect(seen[0][1]).toBe(seen[1][1])
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
    runAnimationFrame(source)
    expect(order).toEqual(["first"])
    runAnimationFrame(source)
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
    runAnimationFrame(source)
    expect(order).toEqual(["first"])
  })

  it("reports a callback that throws and runs the rest", () => {
    const source = windowSource().source
    add(source)
    const reportError = vi.fn()
    vi.stubGlobal("reportError", reportError)
    try {
      const order: string[] = []
      requestAnimationFrame(() => {
        throw new Error("boom")
      })
      requestAnimationFrame(() => order.push("after"))
      runAnimationFrame(source)
      expect(order).toEqual(["after"])
      expect(reportError).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
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
    runAnimationFrame(closed.source)
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
