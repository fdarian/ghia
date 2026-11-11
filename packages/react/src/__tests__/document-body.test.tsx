/**
 * Every window root is `<html>` > `<body>`, the app's top-level nodes are in `body`, and
 * `document.body` is an ordinary element: a portal container, a pointer-capture target and
 * a member of event paths.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document, window, type DomEvent } from "@ghia/native/host"
import { createPortal } from "../reconciler/portal.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("document.body in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    testRoot = createTestRoot()
  })

  afterEach(() => {
    testRoot.unmount()
  })

  it("is null before anything is mounted and again after the root unmounts", () => {
    testRoot.render(<div style={{ width: 40, height: 20 }} />)
    expect(document.body).not.toBeNull()
    testRoot.unmount()
    expect(document.documentElement).toBeNull()
    expect(document.head).toBeNull()
    expect(document.body).toBeNull()
    expect(document.scrollingElement).toBeNull()
    testRoot = createTestRoot()
  })

  it("takes the destroyed html out of the document", () => {
    testRoot.render(<div style={{ width: 40, height: 20 }} />)
    const html = document.documentElement!
    expect(html.parentNode).toBe(document)
    testRoot.unmount()
    expect(html.parentNode).toBeNull()
    expect(html.isConnected).toBe(false)
    expect(document.contains(html)).toBe(false)
    expect(html.nextSibling).toBeNull()
    testRoot = createTestRoot()
  })

  it("has html, body and the app's top-level element in a parent chain up to the document", () => {
    let box: PublicInstance | null = null
    testRoot.render(<div ref={(instance) => (box = instance)} style={{ width: 40, height: 20 }} />)
    const html = document.documentElement!
    const body = document.body!
    expect(html.tagName).toBe("HTML")
    expect(html.localName).toBe("html")
    expect(body.tagName).toBe("BODY")
    expect(document.scrollingElement).toBe(html)
    expect(html.parentNode).toBe(document)
    expect(html.parentElement).toBeNull()
    expect(body.parentNode).toBe(html)
    expect(body.parentElement).toBe(html)
    expect(box!.parentNode).toBe(body)
    expect([...html.children]).toEqual([document.head, body])
    expect([...body.children]).toEqual([box])
    expect([...document.childNodes]).toEqual([html])
    expect(html.previousSibling).toBeNull()
    expect(html.nextSibling).toBeNull()
    expect(box!.getRootNode()).toBe(document)
    expect(body.getRootNode()).toBe(document)
    expect(html.getRootNode()).toBe(document)
    expect(body.isConnected).toBe(true)
    expect(html.isConnected).toBe(true)
    expect(html.contains(box)).toBe(true)
    expect(body.contains(box)).toBe(true)
    expect(box!.contains(body)).toBe(false)
    expect(document.contains(box)).toBe(true)
    expect(body.compareDocumentPosition(box!)).toBe(20)
    expect(html.compareDocumentPosition(body)).toBe(20)
    expect(box!.compareDocumentPosition(body)).toBe(10)
  })

  it("has a head before body in html, which draws nothing", () => {
    let box: PublicInstance | null = null
    testRoot.render(<div ref={(instance) => (box = instance)} style={{ width: 40, height: 20 }} />)
    const html = document.documentElement!
    const head = document.head!
    expect(head.tagName).toBe("HEAD")
    expect(head.localName).toBe("head")
    expect(head.parentNode).toBe(html)
    expect(head.parentElement).toBe(html)
    expect(head.nextSibling).toBe(document.body)
    expect(document.body!.previousSibling).toBe(head)
    expect(head.ownerDocument).toBe(document)
    expect(head.getRootNode()).toBe(document)
    expect(head.isConnected).toBe(true)
    expect(head.children.length).toBe(0)
    expect(html.contains(head)).toBe(true)
    expect(head.contains(box)).toBe(false)
    expect(head.compareDocumentPosition(document.body!)).toBe(4)
    expect(head.getBoundingClientRect()).toMatchObject({ width: 0, height: 0 })
    expect(box!.getBoundingClientRect()).toMatchObject({ x: 0, y: 0, width: 40, height: 20 })
  })

  it("keeps an element appended to head out of the layout", () => {
    let inHead: PublicInstance | null = null
    testRoot.render(
      <>
        {createPortal(
          <div ref={(instance) => (inHead = instance)} style={{ width: 70, height: 50 }} />,
          document.head as unknown as PublicInstance
        )}
        <div style={{ width: 40, height: 20 }} />
      </>
    )
    expect(inHead!.parentNode).toBe(document.head)
    expect(inHead!.getBoundingClientRect()).toMatchObject({ width: 0, height: 0 })
    expect(document.body!.children.length).toBe(1)
  })

  it("has the document as the owner of body and of the top-level element", () => {
    let box: PublicInstance | null = null
    testRoot.render(<div ref={(instance) => (box = instance)} style={{ width: 40, height: 20 }} />)
    expect(box!.ownerDocument).toBe(document)
    expect(document.body!.ownerDocument).toBe(document)
  })

  it("draws and lays out every top-level sibling, one under the other", () => {
    let first: PublicInstance | null = null
    let second: PublicInstance | null = null
    testRoot.render(
      <>
        <div ref={(instance) => (first = instance)} style={{ width: 40, height: 20 }} />
        <div ref={(instance) => (second = instance)} style={{ width: 60, height: 30 }} />
      </>
    )
    expect([...document.body!.children]).toEqual([first, second])
    const a = first!.getBoundingClientRect()
    const b = second!.getBoundingClientRect()
    expect(a).toMatchObject({ x: 0, y: 0, width: 40, height: 20 })
    expect(b).toMatchObject({ x: 0, y: 20, width: 60, height: 30 })
  })

  it("keeps the app's top element the size it was: html and body fill the window", () => {
    let box: PublicInstance | null = null
    testRoot.render(<div ref={(instance) => (box = instance)} style={{ width: "100%", height: "100%" }} />)
    const html = document.documentElement!.getBoundingClientRect()
    const body = document.body!.getBoundingClientRect()
    const app = box!.getBoundingClientRect()
    expect(html).toMatchObject({ x: 0, y: 0 })
    expect(body).toMatchObject({ x: 0, y: 0, width: html.width, height: html.height })
    expect(app).toMatchObject({ x: 0, y: 0, width: html.width, height: html.height })
    expect(html.width).toBeGreaterThan(0)
    expect(html.height).toBeGreaterThan(0)
  })

  it("mounts a portal into document.body beside the app's own nodes", () => {
    let layer: PublicInstance | null = null
    function App() {
      return (
        <>
          <div style={{ width: 40, height: 20 }} />
          {createPortal(
            <div ref={(instance) => (layer = instance)} testId="portal" style={{ width: 30, height: 10 }} />,
            document.body as unknown as PublicInstance
          )}
        </>
      )
    }
    testRoot.render(<App />)
    expect(layer!.parentNode === document.body).toBe(true)
    expect(document.body!.children.length).toBe(2)
    expect([...document.body!.children].includes(layer!)).toBe(true)
    expect(layer!.getBoundingClientRect()).toMatchObject({ width: 30, height: 10 })
  })

  it("routes moves to document.body once it takes pointer capture during a press", () => {
    const targets: unknown[] = []
    testRoot.render(
      <div
        style={{ width: 100, height: 100 }}
        onPointerDown={() => document.body!.setPointerCapture(1)}
      />
    )
    expect(document.body!.hasPointerCapture(1)).toBe(false)
    document.body!.addEventListener("pointermove", (event: DomEvent) => targets.push(event.target))
    testRoot.renderer.nativeSimulateMouseDown(50, 50)
    expect(document.body!.hasPointerCapture(1)).toBe(true)
    testRoot.renderer.nativeSimulateMouseMove(60, 60)
    testRoot.renderer.nativeSimulateMouseMove(300, 300)
    expect(targets).toEqual([document.body, document.body])
    testRoot.renderer.nativeSimulateMouseUp(300, 300)
    expect(document.body!.hasPointerCapture(1)).toBe(false)
  })

  it("bubbles an event from the app through body and html to document and window", () => {
    const order: string[] = []
    testRoot.render(
      <div style={{ width: 100, height: 100 }} onClick={() => order.push("div")} />
    )
    const note = (name: string) => () => order.push(name)
    const cleanups = [
      [document.body!, note("body")],
      [document.documentElement!, note("html")],
      [document, note("document")],
      [window, note("window")],
    ] as const
    for (const [target, listener] of cleanups) target.addEventListener("click", listener)
    try {
      testRoot.renderer.nativeSimulateClick(50, 50)
      expect(order).toEqual(["div", "body", "html", "document", "window"])
    } finally {
      for (const [target, listener] of cleanups) target.removeEventListener("click", listener)
    }
  })

  it("makes a click on empty window space target body", () => {
    const seen: unknown[] = []
    testRoot.render(<div style={{ width: 40, height: 20 }} />)
    const listener = (event: DomEvent) => seen.push(event.target)
    window.addEventListener("click", listener)
    try {
      testRoot.renderer.nativeSimulateClick(300, 300)
    } finally {
      window.removeEventListener("click", listener)
    }
    expect(seen).toEqual([document.body])
  })
})
