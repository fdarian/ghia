import { describe, expect, it } from "vitest"
import { FrameList, type FrameSource } from "../animation-frame.js"

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

describe("a window's frame list", () => {
  it("asks its window once until its frame runs", () => {
    const window = windowSource()
    const frames = new FrameList()
    frames.attach(window.source)
    frames.request(() => {})
    frames.request(() => {})
    expect(window.state.asks).toBe(1)
    frames.run(0, report)
    frames.request(() => {})
    expect(window.state.asks).toBe(2)
  })

  it("keeps the callbacks of each window apart: one window's frame runs its own and no other's", () => {
    const first = windowSource()
    const second = windowSource()
    const firstFrames = new FrameList()
    const secondFrames = new FrameList()
    firstFrames.attach(first.source)
    secondFrames.attach(second.source)
    const seen: Array<[string, number]> = []
    firstFrames.request((time) => seen.push(["first", time]))
    secondFrames.request((time) => seen.push(["second", time]))
    expect([first.state.asks, second.state.asks]).toEqual([1, 1])
    secondFrames.run(7, report)
    expect(seen).toEqual([["second", 7]])
    firstFrames.run(9, report)
    expect(seen).toEqual([["second", 7], ["first", 9]])
  })

  it("runs the callbacks in order with one time", () => {
    const frames = new FrameList()
    frames.attach(windowSource().source)
    const seen: Array<[string, number]> = []
    frames.request((time) => seen.push(["a", time]))
    frames.request((time) => seen.push(["b", time]))
    frames.run(1234.5, report)
    frames.run(9999, report)
    expect(seen).toEqual([["a", 1234.5], ["b", 1234.5]])
  })

  it("hands out handles that name one callback of the app, whichever list it is in", () => {
    const first = new FrameList()
    const second = new FrameList()
    const handles = [first.request(() => {}), second.request(() => {}), first.request(() => {})]
    expect(new Set(handles).size).toBe(3)
  })

  it("keeps what a callback requests for the next frame", () => {
    const frames = new FrameList()
    frames.attach(windowSource().source)
    const order: string[] = []
    frames.request(() => {
      order.push("first")
      frames.request(() => order.push("nested"))
    })
    frames.run(0, report)
    expect(order).toEqual(["first"])
    frames.run(0, report)
    expect(order).toEqual(["first", "nested"])
  })

  it("does not run a cancelled callback, one of the running frame included", () => {
    const frames = new FrameList()
    frames.attach(windowSource().source)
    const order: string[] = []
    const cancelled = frames.request(() => order.push("cancelled"))
    let later = 0
    frames.request(() => {
      order.push("first")
      frames.cancel(later)
    })
    later = frames.request(() => order.push("later"))
    frames.cancel(cancelled)
    frames.run(0, report)
    expect(order).toEqual(["first"])
  })

  it("reports a callback that throws to the reporter and runs the rest", () => {
    const frames = new FrameList()
    frames.attach(windowSource().source)
    const reported: unknown[] = []
    const order: string[] = []
    const boom = new Error("boom")
    frames.request(() => {
      throw boom
    })
    frames.request(() => order.push("after"))
    frames.run(0, (error) => reported.push(error))
    expect(order).toEqual(["after"])
    expect(reported).toEqual([boom])
  })

  it("does not throw when the window refuses the request, and runs the callback in a later frame", () => {
    const frames = new FrameList()
    frames.attach({
      requestAnimationFrame() {
        throw new Error("no window")
      },
    })
    const order: string[] = []
    expect(() => frames.request(() => order.push("ran"))).not.toThrow()
    expect(order).toEqual([])
    frames.run(0, report)
    expect(order).toEqual(["ran"])
  })

  it("asks a window that attaches after a refused request", () => {
    const frames = new FrameList()
    frames.attach({
      requestAnimationFrame() {
        throw new Error("no window")
      },
    })
    const order: string[] = []
    frames.request(() => order.push("ran"))
    const later = windowSource()
    frames.attach(later.source)
    expect(later.state.asks).toBe(1)
    frames.run(0, report)
    expect(order).toEqual(["ran"])
  })

  it("waits for a window, and asks again once a window that was not open takes requests", () => {
    const frames = new FrameList()
    const order: string[] = []
    frames.request(() => order.push("waited"))
    const closed = windowSource(false)
    frames.attach(closed.source)
    expect(closed.state.asks).toBe(1)
    closed.state.open = true
    frames.resume()
    expect(closed.state.asks).toBe(2)
    frames.run(0, report)
    expect(order).toEqual(["waited"])
  })

  it("stops asking a window that was taken out", () => {
    const gone = windowSource()
    const frames = new FrameList()
    const detach = frames.attach(gone.source)
    detach()
    frames.request(() => {})
    expect(gone.state.asks).toBe(0)
  })
})
