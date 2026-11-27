/**
 * React renders into other windows the web way: `window.open('')` gives an empty root (the adapter's
 * window factory), `createRoot(w.document.body)` mounts there, and `createPortal(children, w.document.body)` reaches it.
 */
import { useEffect, useState, useSyncExternalStore } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createRoot, flushSync, render, resetRender } from "../reconciler/renderer.js"
import { createPortal } from "../reconciler/portal.js"
import { createTestRoot, hasNativeTestRenderer, TestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const settle = async (...renderers: TestRenderer[]) => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const renderer of renderers) renderer.flush()
}

let opened = 0

function openSide(): { popup: Window & typeof globalThis; renderer: TestRenderer; body: PublicInstance } {
  const popup = window.open("", `side-${(opened += 1)}`, "width=300,height=200") as (Window & typeof globalThis) | null
  if (popup === null) throw new Error("window.open returned null")
  return {
    popup,
    renderer: (popup as unknown as { renderer: TestRenderer }).renderer,
    body: popup.document.body as unknown as PublicInstance,
  }
}

describeNative("React in another window", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 400, height: 300 })
  })

  afterEach(() => {
    app.unmount()
  })

  it("opens a window with an empty root", () => {
    app.render(<div>main</div>)
    const { popup, renderer } = openSide()
    expect(popup.document.body.childNodes.length).toBe(0)
    expect(popup.document.body).not.toBe(document.body)
    expect(renderer.getAllText()).toEqual([])
  })

  it("renders into the popup's body with createRoot(container)", async () => {
    app.render(<div>main</div>)
    const { popup, renderer, body } = openSide()
    const root = createRoot(body)
    flushSync(() => root.render(<p testId="popup-text">hello popup</p>))
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual(["hello popup"])
    expect(app.renderer.getAllText()).toEqual(["main"])
    expect(popup.document.body.querySelector("p")?.textContent).toBe("hello popup")
    root.unmount()
    await settle(renderer)
    expect(renderer.getAllText()).toEqual([])
    expect(popup.document.body.textContent).toBe("")
  })

  it("keeps state shared between the windows driving both", async () => {
    let count = 0
    const listeners = new Set<() => void>()
    const store = {
      subscribe: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
      get: () => count,
    }
    const bump = (next: number) => {
      count = next
      for (const listener of listeners) listener()
    }
    function Shown(props: { name: string }) {
      return <div>{`${props.name} ${useSyncExternalStore(store.subscribe, store.get)}`}</div>
    }
    app.render(<Shown name="main" />)
    const { renderer, body } = openSide()
    const root = createRoot(body)
    flushSync(() => root.render(<Shown name="popup" />))
    await settle(renderer)
    expect(renderer.getAllText()).toEqual(["popup 0"])
    flushSync(() => bump(5))
    await settle(renderer, app.renderer)
    expect(app.renderer.getAllText()).toEqual(["main 5"])
    expect(renderer.getAllText()).toEqual(["popup 5"])
  })

  it("delivers the popup's events to its handlers", async () => {
    app.render(<div>main</div>)
    const { renderer, body } = openSide()
    const clicks: string[] = []
    const root = createRoot(body)
    flushSync(() => root.render(<div testId="button" onClick={() => clicks.push("popup")} style={{ width: 80, height: 30 }} />))
    await settle(renderer)
    const bounds = renderer.getElementBounds(renderer.findByTestId("button")!.id)!
    renderer.nativeSimulateClick(bounds.x + 5, bounds.y + 5)
    expect(clicks).toEqual(["popup"])
  })

  it("provides the popup's own window to useGpuix", async () => {
    const { useGpuix } = await import("../index.js")
    app.render(<div>main</div>)
    const { renderer, body } = openSide()
    let seen: unknown
    function Probe() {
      seen = useGpuix().renderer
      return <div />
    }
    const root = createRoot(body)
    flushSync(() => root.render(<Probe />))
    expect(seen).toBe(renderer)
  })

  it("closing the window unmounts what was rendered in it, running cleanups", async () => {
    app.render(<div>main</div>)
    const { popup, renderer, body } = openSide()
    const log: string[] = []
    function Content() {
      useEffect(() => () => void log.push("cleanup"), [])
      return <div>popup</div>
    }
    const root = createRoot(body)
    flushSync(() => root.render(<Content />))
    await settle(renderer)
    popup.close()
    expect(log).toEqual(["cleanup"])
    expect(popup.closed).toBe(true)
    expect(() => root.unmount()).not.toThrow()
    await settle(app.renderer)
    expect(app.renderer.getAllText()).toEqual(["main"])
  })

  it("mounts a portal from the main tree into the popup, following the owner's state", async () => {
    let setText!: (text: string) => void
    let setShown!: (shown: boolean) => void
    const log: string[] = []
    function Portaled(props: { text: string }) {
      useEffect(() => () => void log.push("portal cleanup"), [])
      return <div testId="portaled">{props.text}</div>
    }
    app.render(<div>main</div>)
    const { renderer, body } = openSide()
    function Owner() {
      const [text, setT] = useState("one")
      const [shown, setS] = useState(true)
      setText = setT
      setShown = setS
      return (
        <div>
          <span>owner</span>
          {shown && createPortal(<Portaled text={text} />, body)}
        </div>
      )
    }
    app.render(<Owner />)
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual(["one"])
    expect(app.renderer.getAllText()).toEqual(["owner"])
    flushSync(() => setText("two"))
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual(["two"])
    const bounds = renderer.getElementBounds(renderer.findByTestId("portaled")!.id)
    expect(bounds).not.toBeNull()
    flushSync(() => setShown(false))
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual([])
    expect(log).toEqual(["portal cleanup"])
  })

  it("lets the popup open a window of its own", () => {
    app.render(<div>main</div>)
    const { popup } = openSide()
    const second = popup.open("", "second") as Window | null
    expect(second).not.toBeNull()
    expect(second).not.toBe(popup)
  })

  it("keeps a root for each renderer render() is given, and remounts on the same renderer", async () => {
    const first = new TestRenderer({ width: 200, height: 100 })
    const second = new TestRenderer({ width: 200, height: 100 })
    try {
      render(<div>first</div>, { renderer: first })
      render(<div>second</div>, { renderer: second })
      await settle(first, second)
      expect(first.getAllText()).toEqual(["first"])
      expect(second.getAllText()).toEqual(["second"])
      render(<div>first again</div>, { renderer: first })
      await settle(first, second)
      expect(first.getAllText()).toEqual(["first again"])
      expect(second.getAllText()).toEqual(["second"])
    } finally {
      resetRender()
      first.dispose()
      second.dispose()
    }
  })
})
