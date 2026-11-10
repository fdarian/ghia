// What libraries written for the DOM reach a host instance for: `addEventListener` beside the `on*` props,
// `ownerDocument`, `isConnected`, `getAttribute`, and the window's `requestAnimationFrame`.
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { document, type PublicInstance, type ScrollEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("DOM members of a React host instance", () => {
  function center(root: ReturnType<typeof createTestRoot>, testId: string): [number, number] {
    const bounds = root.renderer.getElementBounds(root.renderer.findByTestId(testId)!.id)!
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
  }

  it("runs addEventListener listeners with the on* prop, in the order the DOM gives", () => {
    const calls: string[] = []
    let box: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div
        ref={(instance) => {
          box = instance as PublicInstance | null
        }}
        testId="box"
        style={{ width: 60, height: 30 }}
        onClick={() => calls.push("prop")}
      />
    )
    box!.addEventListener("click", () => calls.push("listener"))
    box!.addEventListener("click", () => calls.push("capture"), { capture: true })
    root.renderer.nativeSimulateClick(...center(root, "box"))
    expect(calls).toEqual(["capture", "prop", "listener"])
    root.unmount()
  })

  it("keeps listeners when the prop changes or goes away", () => {
    const calls: string[] = []
    let box: PublicInstance | null = null
    const root = createTestRoot()
    const view = (handler?: () => void) => (
      <div
        ref={(instance) => {
          box = instance as PublicInstance | null
        }}
        testId="box"
        style={{ width: 60, height: 30 }}
        onClick={handler}
      />
    )
    root.render(view(() => calls.push("prop 1")))
    box!.addEventListener("click", () => calls.push("listener"))
    root.render(view(() => calls.push("prop 2")))
    root.renderer.nativeSimulateClick(...center(root, "box"))
    root.render(view(undefined))
    root.renderer.nativeSimulateClick(...center(root, "box"))
    expect(calls).toEqual(["prop 2", "listener", "listener"])
    root.unmount()
  })

  it("delivers a scroll listener's event before the frame that paints the offset", () => {
    let scroller: PublicInstance | null = null
    function Page() {
      const [reported, setReported] = useState(0)
      return (
        <div
          ref={(instance) => {
            if (instance && !scroller) {
              scroller = instance as PublicInstance
              scroller.addEventListener("scroll", (event) => setReported(Math.round((event as ScrollEvent).scrollTop)), {
                passive: true,
              })
            }
          }}
          style={{ width: 200, height: 100, overflow: "auto" }}
        >
          <div style={{ position: "sticky", top: 0, height: 20 }}>{`offset ${reported}`}</div>
          <div style={{ height: 1000 }} />
        </div>
      )
    }
    const root = createTestRoot()
    root.renderer.clockPause()
    root.renderer.setInlineDraws(false)
    root.render(<Page />)
    root.renderer.drawFrame()
    scroller!.scrollTop = 300
    const before = root.renderer.getPaintedFrameCount()
    root.renderer.drawFrame()
    expect(root.renderer.getPaintedFrameCount() - before).toBe(1)
    expect(root.renderer.getPaintedText()).toContain("offset 300")
    root.unmount()
  })

  it("answers ownerDocument, isConnected and getAttribute", () => {
    let row: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div style={{ width: 20, height: 20 }}>
        <div
          ref={(instance) => {
            row = instance as PublicInstance | null
          }}
          data-index={7}
          style={{ width: 10, height: 10 }}
        />
      </div>
    )
    expect("ownerDocument" in row!).toBe(true)
    expect(row!.ownerDocument).toBe(document)
    expect(row!.ownerDocument.defaultView).toBe(globalThis)
    expect(row!.isConnected).toBe(true)
    expect(row!.getAttribute("data-index")).toBe("7")
    expect(row!.getAttribute("data-missing")).toBeNull()
    root.unmount()
  })

  it("answers offsetWidth and offsetHeight with the layout size, whatever transform the element has", () => {
    const boxes: Record<string, PublicInstance | null> = {}
    const ref = (name: string) => (instance: unknown) => {
      boxes[name] = instance as PublicInstance | null
    }
    const root = createTestRoot()
    root.render(
      <div style={{ width: 400, height: 400 }}>
        <div ref={ref("plain")} style={{ width: 33.4, height: 20.6 }} />
        <div ref={ref("moved")} style={{ width: 50, height: 30, transform: "translate(40px, 12px)" }} />
        <div ref={ref("scaled")} testId="scaled" style={{ width: 50, height: 30, transform: "scale(2)" }} />
      </div>
    )
    expect([boxes.plain!.offsetWidth, boxes.plain!.offsetHeight]).toEqual([33, 21])
    expect([boxes.moved!.offsetWidth, boxes.moved!.offsetHeight]).toEqual([50, 30])
    expect([boxes.scaled!.offsetWidth, boxes.scaled!.offsetHeight]).toEqual([50, 30])
    const scaledBounds = root.renderer.getElementBounds(root.renderer.findByTestId("scaled")!.id)!
    expect(scaledBounds.width).toBe(100)
    root.unmount()
  })

  it("runs requestAnimationFrame callbacks before the draw that paints what they change", () => {
    let setLabel!: (label: string) => void
    function Page() {
      const [label, set] = useState("before")
      setLabel = set
      return <div style={{ width: 100, height: 20 }}>{label}</div>
    }
    const root = createTestRoot()
    root.renderer.clockPause()
    root.renderer.setInlineDraws(false)
    root.render(<Page />)
    requestAnimationFrame(() => setLabel("after"))
    const painted = root.renderer.getPaintedFrameCount()
    root.renderer.drawFrame()
    expect(root.renderer.getPaintedFrameCount() - painted).toBe(1)
    expect(root.renderer.getPaintedText()).toContain("after")
    root.unmount()
  })
})
