/**
 * Every window root is `<html>` > `<body>`, the app's top-level nodes are in `body`, and
 * `document.body` is an ordinary element: a pointer-capture target and a member of event paths.
 */
import { Match, Show, Switch, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document, window, type DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("document.body in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  it("is null with nothing mounted", () => {
    app.unmount()
    expect(document.documentElement).toBeNull()
    expect(document.head).toBeNull()
    expect(document.body).toBeNull()
    expect(document.scrollingElement).toBeNull()
    app = createTestRoot()
  })

  it("has html, body and the app's top-level element in a parent chain up to the document", () => {
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={{ width: 40, height: 20 }} />)
    const html = document.documentElement!
    const body = document.body!
    expect(html.tagName).toBe("HTML")
    expect(body.tagName).toBe("BODY")
    expect(document.scrollingElement).toBe(html)
    expect(html.parentNode).toBe(document)
    expect(html.parentElement).toBeNull()
    expect(body.parentNode).toBe(html)
    expect(box!.parentNode).toBe(body)
    expect([...html.children]).toEqual([document.head, body])
    expect([...body.children]).toEqual([box])
    expect([...document.childNodes]).toEqual([html])
    expect(box!.getRootNode()).toBe(document)
    expect(body.getRootNode()).toBe(document)
    expect(body.isConnected).toBe(true)
    expect(html.isConnected).toBe(true)
    expect(html.contains(box!)).toBe(true)
    expect(body.contains(box!)).toBe(true)
    expect(box!.contains(body)).toBe(false)
    expect(document.contains(box!)).toBe(true)
    expect(body.compareDocumentPosition(box!)).toBe(20)
    expect(box!.compareDocumentPosition(body)).toBe(10)
    expect(box!.ownerDocument).toBe(document)
  })

  it("has a head before body in html, which draws nothing", () => {
    let box: HTMLElement | undefined
    app.render(() => <div ref={(element) => (box = element as unknown as HTMLElement)} style={{ width: 40, height: 20 }} />)
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
    expect(head.contains(box!)).toBe(false)
    expect(head.compareDocumentPosition(document.body!)).toBe(4)
    expect(head.getBoundingClientRect()).toMatchObject({ width: 0, height: 0 })
    expect(box!.getBoundingClientRect()).toMatchObject({ x: 0, y: 0, width: 40, height: 20 })
  })

  it("draws and lays out every top-level sibling, one under the other", () => {
    let first: HTMLElement | undefined
    let second: HTMLElement | undefined
    app.render(() => (
      <>
        <div ref={(element) => (first = element as unknown as HTMLElement)} style={{ width: 40, height: 20 }} />
        <div ref={(element) => (second = element as unknown as HTMLElement)} style={{ width: 60, height: 30 }} />
      </>
    ))
    expect([...document.body!.children]).toEqual([first, second])
    expect(first!.getBoundingClientRect()).toMatchObject({ x: 0, y: 0, width: 40, height: 20 })
    expect(second!.getBoundingClientRect()).toMatchObject({ x: 0, y: 20, width: 60, height: 30 })
  })

  it("keeps the app's top element the size it was: html and body fill the window", () => {
    let box: HTMLElement | undefined
    app.render(() => (
      <div ref={(element) => (box = element as unknown as HTMLElement)} style={{ width: "100%", height: "100%" }} />
    ))
    const html = document.documentElement!.getBoundingClientRect()
    expect(document.body!.getBoundingClientRect()).toMatchObject({ x: 0, y: 0, width: html.width, height: html.height })
    expect(box!.getBoundingClientRect()).toMatchObject({ x: 0, y: 0, width: html.width, height: html.height })
    expect(html.width).toBeGreaterThan(0)
    expect(html.height).toBeGreaterThan(0)
  })

  it("renders again into a new html and body", () => {
    app.render(() => <div style={{ width: 40, height: 20 }} />)
    const firstBody = document.body
    app.render(() => <div testId="again" style={{ width: 40, height: 20 }} />)
    expect(document.body).not.toBeNull()
    expect(document.body).not.toBe(firstBody)
    expect(app.renderer.findByTestId("again")).toBeDefined()
    expect(document.body!.children).toHaveLength(1)
  })

  it("removes top-level nodes when the output goes from several nodes to one", () => {
    const [many, setMany] = createSignal(true)
    app.render(() => (
      <Show when={many()} fallback={<div testId="one" style={{ width: 10, height: 10 }} />}>
        <div testId="a" style={{ width: 10, height: 10 }} />
        <div testId="b" style={{ width: 10, height: 10 }} />
      </Show>
    ))
    expect(document.body!.children).toHaveLength(2)
    app.flushSync(() => setMany(false))
    expect(document.body!.children).toHaveLength(1)
    expect(app.renderer.findByTestId("one")).toBeDefined()
    expect(app.renderer.findByTestId("a")).toBeUndefined()
    expect(app.renderer.findByTestId("b")).toBeUndefined()
    app.flushSync(() => setMany(true))
    expect(document.body!.children).toHaveLength(2)
    expect(app.renderer.findByTestId("one")).toBeUndefined()
    expect(app.renderer.findByTestId("a")).toBeDefined()
  })

  it("swaps a top-level fragment and a single node in a Switch", () => {
    const [which, setWhich] = createSignal<"fragment" | "single">("fragment")
    app.render(() => (
      <Switch>
        <Match when={which() === "fragment"}>
          <>
            <div testId="a" style={{ width: 10, height: 10 }} />
            <div testId="b" style={{ width: 10, height: 10 }} />
          </>
        </Match>
        <Match when={which() === "single"}>
          <div testId="one" style={{ width: 10, height: 10 }} />
        </Match>
      </Switch>
    ))
    expect(document.body!.children).toHaveLength(2)
    app.flushSync(() => setWhich("single"))
    expect(document.body!.children).toHaveLength(1)
    expect(app.renderer.findByTestId("a")).toBeUndefined()
    expect(app.renderer.findByTestId("b")).toBeUndefined()
    app.flushSync(() => setWhich("fragment"))
    expect(document.body!.children).toHaveLength(2)
    expect(app.renderer.findByTestId("one")).toBeUndefined()
  })

  it("routes moves to document.body once it takes pointer capture during a press", () => {
    const targets: unknown[] = []
    app.render(() => <div style={{ width: 100, height: 100 }} onPointerDown={() => document.body!.setPointerCapture(1)} />)
    expect(document.body!.hasPointerCapture(1)).toBe(false)
    document.body!.addEventListener("pointermove", (event: DomEvent) => targets.push(event.target))
    app.renderer.nativeSimulateMouseDown(50, 50)
    expect(document.body!.hasPointerCapture(1)).toBe(true)
    app.renderer.nativeSimulateMouseMove(60, 60)
    app.renderer.nativeSimulateMouseMove(300, 300)
    expect(targets).toEqual([document.body, document.body])
    app.renderer.nativeSimulateMouseUp(300, 300)
    expect(document.body!.hasPointerCapture(1)).toBe(false)
  })

  it("bubbles an event from the app through body and html to document and window", () => {
    const order: string[] = []
    app.render(() => <div style={{ width: 100, height: 100 }} onClick={() => order.push("div")} />)
    const note = (name: string) => () => order.push(name)
    const targets = [
      [document.body!, note("body")],
      [document.documentElement!, note("html")],
      [document, note("document")],
      [window, note("window")],
    ] as const
    for (const [target, listener] of targets) target.addEventListener("click", listener)
    try {
      app.renderer.nativeSimulateClick(50, 50)
      expect(order).toEqual(["div", "body", "html", "document", "window"])
    } finally {
      for (const [target, listener] of targets) target.removeEventListener("click", listener)
    }
  })

  it("makes a click on empty window space target body", () => {
    const seen: unknown[] = []
    app.render(() => <div style={{ width: 40, height: 20 }} />)
    const listener = (event: DomEvent) => seen.push(event.target)
    window.addEventListener("click", listener)
    try {
      app.renderer.nativeSimulateClick(300, 300)
    } finally {
      window.removeEventListener("click", listener)
    }
    expect(seen).toEqual([document.body])
  })
})
