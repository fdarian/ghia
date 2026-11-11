// What libraries written for the DOM reach a host instance for: `addEventListener` beside the `on*` props,
// `ownerDocument`, `isConnected`, `getAttribute`, and the window's `requestAnimationFrame`.
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { document, Element, HTMLElement, Node, SVGElement, Text, type PublicInstance, type ScrollEvent } from "@ghia/native/host"
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

  describe("DOM node shape", () => {
    it("is an HTMLElement, Element and Node, and an svg and its shapes are SVGElements", () => {
      let box: PublicInstance | null = null
      let svg: PublicInstance | null = null
      let path: PublicInstance | null = null
      const root = createTestRoot()
      root.render(
        <div
          ref={(instance) => {
            box = instance as PublicInstance | null
          }}
          style={{ width: 40, height: 40 }}
        >
          <svg
            ref={(instance) => {
              svg = instance as PublicInstance | null
            }}
            width={20}
            height={20}
          >
            <path
              ref={(instance) => {
                path = instance as PublicInstance | null
              }}
              d="M0 0L10 10"
            />
          </svg>
        </div>
      )
      expect(box instanceof HTMLElement).toBe(true)
      expect(box instanceof Element).toBe(true)
      expect(box instanceof Node).toBe(true)
      expect(box instanceof SVGElement).toBe(false)
      expect(svg instanceof SVGElement).toBe(true)
      expect(svg instanceof HTMLElement).toBe(false)
      expect(path instanceof SVGElement).toBe(true)
      expect(path instanceof Element).toBe(true)
      expect(box!.tagName).toBe("DIV")
      expect(box!.localName).toBe("div")
      expect(path!.tagName).toBe("path")
      expect(path!.localName).toBe("path")
      expect(typeof path!.focus).toBe("function")
      expect(typeof path!.getBoundingClientRect).toBe("function")
      expect(path!.isConnected).toBe(true)
      expect(path!.getAttribute("d")).toBe("M0 0L10 10")
      root.unmount()
    })

    it("walks the tree, with text nodes among the child nodes", () => {
      let parent: PublicInstance | null = null
      let first: PublicInstance | null = null
      let last: PublicInstance | null = null
      const root = createTestRoot()
      root.render(
        <div
          ref={(instance) => {
            parent = instance as PublicInstance | null
          }}
          style={{ width: 80, height: 40 }}
        >
          <span
            ref={(instance) => {
              first = instance as PublicInstance | null
            }}
          >
            one
          </span>
          {"two"}
          <span
            ref={(instance) => {
              last = instance as PublicInstance | null
            }}
          >
            three
          </span>
        </div>
      )
      expect(parent!.childNodes).toHaveLength(3)
      const text = parent!.childNodes[1]
      expect(text instanceof Text).toBe(true)
      expect(text.nodeType).toBe(3)
      expect(text.textContent).toBe("two")
      expect(text.previousSibling).toBe(first)
      expect(text.nextSibling).toBe(last)
      expect(text.parentNode).toBe(parent)
      expect(text.isConnected).toBe(true)
      expect(parent!.children).toEqual([first, last])
      expect(parent!.childElementCount).toBe(2)
      expect(first!.nextElementSibling).toBe(last)
      expect(last!.previousElementSibling).toBe(first)
      expect(parent!.textContent).toBe("onetwothree")
      expect(parent!.contains(last)).toBe(true)
      expect(parent!.contains(parent)).toBe(true)
      expect(last!.contains(parent)).toBe(false)
      expect(first!.compareDocumentPosition(last!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(parent!.compareDocumentPosition(first!)).toBe(
        Node.DOCUMENT_POSITION_CONTAINED_BY | Node.DOCUMENT_POSITION_FOLLOWING
      )
      expect(first!.getRootNode()).toBe(document)
      root.unmount()
    })

    it("keeps the order and the parent when children are inserted, reordered and removed", () => {
      let parent: PublicInstance | null = null
      const row = (key: string) => <i key={key} data-key={key} />
      const view = (keys: string[]) => (
        <div
          ref={(instance) => {
            parent = instance as PublicInstance | null
          }}
          style={{ width: 80, height: 40 }}
        >
          {keys.map(row)}
        </div>
      )
      const keysOf = () => parent!.children.map((child) => child.getAttribute("data-key"))
      const root = createTestRoot()
      root.render(view(["a", "b", "c"]))
      const [a, b] = parent!.children
      expect(keysOf()).toEqual(["a", "b", "c"])
      root.render(view(["c", "a", "x", "b"]))
      expect(keysOf()).toEqual(["c", "a", "x", "b"])
      expect(a.parentNode).toBe(parent)
      expect(b.previousElementSibling).toBe(parent!.children[2])
      root.render(view(["b"]))
      expect(keysOf()).toEqual(["b"])
      expect(a.parentNode).toBeNull()
      expect(a.isConnected).toBe(false)
      root.unmount()
    })

    it("reads attributes and dataset from the props", () => {
      let box: PublicInstance | null = null
      const root = createTestRoot()
      root.render(
        <div
          ref={(instance) => {
            box = instance as PublicInstance | null
          }}
          className="card"
          data-row-id="r1"
          data-index={3}
          style={{ width: 10, height: 10 }}
        />
      )
      expect(box!.className).toBe("card")
      expect(box!.getAttributeNames().sort()).toEqual(["class", "data-index", "data-row-id", "style"])
      expect(box!.hasAttribute("data-index")).toBe(true)
      expect(box!.hasAttribute("data-missing")).toBe(false)
      expect(box!.dataset).toEqual({ rowId: "r1", index: "3" })
      root.unmount()
    })

    it("throws Illegal constructor for the public classes", () => {
      expect(() => new (HTMLElement as unknown as new () => object)()).toThrow("Illegal constructor")
      expect(() => new (Node as unknown as new () => object)()).toThrow("Illegal constructor")
    })
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

  it("gives requestAnimationFrame callbacks the clock the frame steps ran at", () => {
    const root = createTestRoot()
    root.renderer.clockPause()
    root.renderer.setInlineDraws(false)
    root.render(<div style={{ width: 100, height: 20 }} />)
    const times: number[] = []
    requestAnimationFrame((time) => times.push(time))
    root.renderer.clockSet(5000)
    root.renderer.drawFrame()
    requestAnimationFrame((time) => times.push(time))
    root.renderer.clockFastForward(250)
    root.renderer.drawFrame()
    expect(times).toHaveLength(2)
    expect(times[1] - times[0]).toBe(250)
    root.unmount()
  })

  it("reports a requestAnimationFrame callback that throws as a handler error, and runs the others", () => {
    const errors: unknown[] = []
    const calls: string[] = []
    const root = createTestRoot({ onError: (error) => errors.push(error) })
    root.renderer.clockPause()
    root.renderer.setInlineDraws(false)
    root.render(<div style={{ width: 100, height: 20 }} />)
    const boom = new Error("boom")
    requestAnimationFrame(() => {
      throw boom
    })
    requestAnimationFrame(() => calls.push("after"))
    root.renderer.drawFrame()
    expect(calls).toEqual(["after"])
    expect(errors).toEqual([boom])
    root.unmount()
  })

  it("fires a capture-only scroll listener, which has no bubble listener to make the event wanted", () => {
    const heard: string[] = []
    let scroller: PublicInstance | null = null
    const root = createTestRoot()
    root.renderer.clockPause()
    root.renderer.setInlineDraws(false)
    root.render(
      <div
        ref={(instance) => {
          scroller = instance as PublicInstance | null
        }}
        testId="scroller"
        style={{ width: 100, height: 50, overflow: "auto" }}
      >
        <div style={{ height: 500 }} />
      </div>
    )
    scroller!.addEventListener("scroll", () => heard.push("capture"), { capture: true })
    // A listener added late reports from the offset of the first paint after it (deviations.md).
    root.renderer.drawFrame()
    root.renderer.scrollTo(root.renderer.findByTestId("scroller")!.id, 0, 100)
    root.renderer.drawFrame()
    expect(heard).toEqual(["capture"])
    root.unmount()
  })

  it("answers getAttribute case-insensitively, with the strings the DOM holds for booleans", () => {
    let row: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div
        ref={(instance) => {
          row = instance as PublicInstance | null
        }}
        data-Flag={false}
        data-on={true}
        aria-expanded={false}
        hidden={true}
        draggable={false}
        title="t"
        onClick={() => {}}
        style={{ width: 10, height: 10 }}
      />
    )
    expect(row!.getAttribute("onclick")).toBeNull()
    expect(row!.getAttribute("style")).toBe("width: 10px; height: 10px;")
    expect(row!.getAttribute("DATA-flag")).toBe("false")
    expect(row!.getAttribute("data-on")).toBe("true")
    expect(row!.getAttribute("Aria-Expanded")).toBe("false")
    expect(row!.getAttribute("hidden")).toBe("")
    expect(row!.getAttribute("draggable")).toBeNull()
    expect(row!.getAttribute("TITLE")).toBe("t")
    expect(row!.getAttribute("data-absent")).toBeNull()
    root.unmount()
  })
})
