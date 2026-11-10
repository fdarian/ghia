/**
 * What libraries written for the DOM (TanStack Virtual, Floating UI) reach an element for:
 * `addEventListener` beside the `on*` props, `ownerDocument.defaultView`, `isConnected`,
 * `getAttribute`, and the window's `requestAnimationFrame`.
 */
import { createSignal, Show } from "solid-js"
import { describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import type { ScrollEvent } from "@ghia/native/host"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("DOM members of a Solid element", () => {
  function setup(render: () => import("solid-js").JSX.Element) {
    const app = createTestRoot()
    app.renderer.clockPause()
    app.renderer.setInlineDraws(false)
    app.render(render)
    app.renderer.drawFrame()
    const center = (testId: string): [number, number] => {
      const bounds = app.renderer.getElementBounds(app.renderer.findByTestId(testId)!.id)!
      return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
    }
    return { ...app, center }
  }

  it("runs addEventListener listeners with the on* prop, in the order the DOM gives", () => {
    const calls: string[] = []
    let box!: HostElement
    const app = setup(() => (
      <div
        ref={box}
        testId="box"
        style={{ width: 60, height: 30 }}
        onClick={() => calls.push("prop")}
      />
    ))
    box.addEventListener("click", () => calls.push("listener"))
    box.addEventListener("click", () => calls.push("capture"), { capture: true })
    app.renderer.nativeSimulateClick(...app.center("box"))
    expect(calls).toEqual(["capture", "prop", "listener"])
    app.unmount()
  })

  it("registers a listener added before the element is mounted, and again after a remount", () => {
    const [shown, setShown] = createSignal(true)
    const calls: string[] = []
    let box!: HostElement
    const app = setup(() => (
      <Show when={shown()}>
        <div ref={box} testId="box" style={{ width: 60, height: 30 }} />
      </Show>
    ))
    const listener = () => calls.push("click")
    box.addEventListener("click", listener)
    app.renderer.nativeSimulateClick(...app.center("box"))
    expect(calls).toEqual(["click"])
    box.removeEventListener("click", listener)
    app.renderer.nativeSimulateClick(...app.center("box"))
    expect(calls).toEqual(["click"])
    setShown(false)
    app.renderer.flush()
    expect(box.isConnected).toBe(false)
    app.unmount()
  })

  it("delivers a scroll listener's event before the frame that paints the offset", () => {
    const [reported, setReported] = createSignal(0)
    let scroller!: HostElement
    const app = setup(() => (
      <div ref={scroller} testId="scroller" style={{ width: 200, height: 100, overflow: "auto" }}>
        <div style={{ position: "sticky", top: 0, height: 20 }}>{`offset ${reported()}`}</div>
        <div style={{ height: 1000 }} />
      </div>
    ))
    scroller.addEventListener(
      "scroll",
      (event) => setReported(Math.round((event as ScrollEvent).scrollTop)),
      { passive: true }
    )
    // The first paint with a listener is the offset it reports from.
    app.flushSync(() => {})
    app.renderer.drawFrame()
    scroller.scrollTop = 300
    const before = app.renderer.getPaintedFrameCount()
    app.renderer.drawFrame()
    expect(app.renderer.getPaintedFrameCount() - before).toBe(1)
    expect(app.renderer.getPaintedText()).toContain("offset 300")
    app.unmount()
  })

  it("has the document of the app, whose defaultView is the window", () => {
    let box!: HostElement
    const app = setup(() => <div ref={box} style={{ width: 10, height: 10 }} />)
    expect("ownerDocument" in box).toBe(true)
    expect(box.ownerDocument).toBe(document)
    expect(box.ownerDocument.defaultView).toBe(globalThis)
    expect(typeof box.ownerDocument.defaultView.setTimeout).toBe("function")
    expect(typeof box.ownerDocument.defaultView.requestAnimationFrame).toBe("function")
    expect(typeof box.ownerDocument.defaultView.ResizeObserver).toBe("function")
    app.unmount()
  })

  it("answers isConnected and getAttribute", () => {
    const [index, setIndex] = createSignal(7)
    let row!: HostElement
    const app = setup(() => (
      <div style={{ width: 20, height: 20 }}>
        <div ref={row} data-index={index()} data-label="row" style={{ width: 10, height: 10 }} />
      </div>
    ))
    expect(row.isConnected).toBe(true)
    expect(row.getAttribute("data-index")).toBe("7")
    expect(row.getAttribute("data-label")).toBe("row")
    expect(row.getAttribute("data-missing")).toBeNull()
    setIndex(8)
    expect(row.getAttribute("data-index")).toBe("8")
    app.unmount()
  })

  it("answers offsetWidth and offsetHeight with the layout size, whatever transform the element has", () => {
    let plain!: HostElement
    let moved!: HostElement
    let scaled!: HostElement
    let unmounted!: HostElement
    const [shown, setShown] = createSignal(true)
    const app = setup(() => (
      <div style={{ width: 400, height: 400 }}>
        <div ref={plain} style={{ width: 33.4, height: 20.6 }} />
        <div ref={moved} style={{ width: 50, height: 30, transform: "translate(40px, 12px)" }} />
        <div ref={scaled} testId="scaled" style={{ width: 50, height: 30, transform: "scale(2)" }} />
        <Show when={shown()}>
          <div ref={unmounted} style={{ width: 10, height: 10 }} />
        </Show>
      </div>
    ))
    expect([plain.offsetWidth, plain.offsetHeight]).toEqual([33, 21])
    expect([moved.offsetWidth, moved.offsetHeight]).toEqual([50, 30])
    expect([scaled.offsetWidth, scaled.offsetHeight]).toEqual([50, 30])
    const scaledBounds = app.renderer.getElementBounds(app.renderer.findByTestId("scaled")!.id)!
    expect(scaledBounds.width).toBe(100)
    expect(unmounted.offsetHeight).toBe(10)
    setShown(false)
    app.renderer.flush()
    expect([unmounted.offsetWidth, unmounted.offsetHeight]).toEqual([0, 0])
    app.unmount()
  })

  describe("requestAnimationFrame", () => {
    it("runs before the draw that paints what its callback changed", () => {
      const [label, setLabel] = createSignal("before")
      const app = setup(() => <div style={{ width: 100, height: 20 }}>{label()}</div>)
      const times: number[] = []
      requestAnimationFrame((time) => {
        times.push(time)
        setLabel("after")
      })
      const painted = app.renderer.getPaintedFrameCount()
      app.renderer.drawFrame()
      expect(app.renderer.getPaintedFrameCount() - painted).toBe(1)
      expect(app.renderer.getPaintedText()).toContain("after")
      expect(times).toHaveLength(1)
      expect(times[0]).toBeGreaterThan(0)
      app.unmount()
    })

    it("runs a callback requested inside a callback in the next frame", () => {
      const app = setup(() => <div style={{ width: 100, height: 20 }} />)
      const order: string[] = []
      requestAnimationFrame(() => {
        order.push("first")
        requestAnimationFrame(() => order.push("nested"))
      })
      app.renderer.drawFrame()
      expect(order).toEqual(["first"])
      app.renderer.drawFrame()
      expect(order).toEqual(["first", "nested"])
      app.renderer.drawFrame()
      expect(order).toEqual(["first", "nested"])
      app.unmount()
    })

    it("does not run a cancelled callback, one of the frame that is running included", () => {
      const app = setup(() => <div style={{ width: 100, height: 20 }} />)
      const order: string[] = []
      const cancelled = requestAnimationFrame(() => order.push("cancelled"))
      let later = 0
      requestAnimationFrame(() => {
        order.push("first")
        cancelAnimationFrame(later)
      })
      later = requestAnimationFrame(() => order.push("later"))
      cancelAnimationFrame(cancelled)
      app.renderer.drawFrame()
      expect(order).toEqual(["first"])
      app.unmount()
    })
  })
})
