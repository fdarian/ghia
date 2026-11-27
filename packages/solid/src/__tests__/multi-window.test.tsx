/**
 * Solid renders into other windows the web way: `window.open('')` gives an empty root (the adapter's
 * window factory), `render(code, w.document.body)` mounts there, and a `Portal` can mount in it.
 */
import { createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { renderSlots } from "@ghia/native/host"
import { render, resetRender } from "../index.js"
import { createTestRoot, hasNativeTestRenderer, TestRenderer } from "../testing.js"

const settle = async (...renderers: TestRenderer[]) => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (const renderer of renderers) renderer.flush()
}

function Portaled(props: { text: () => string; log: string[] }) {
  onCleanup(() => props.log.push("portal cleanup"))
  return <div testId="portaled">{props.text()}</div>
}

let opened = 0

function openSide(): { popup: Window & typeof globalThis; renderer: TestRenderer } {
  const popup = window.open("", `side-${(opened += 1)}`, "width=300,height=200") as (Window & typeof globalThis) | null
  if (popup === null) throw new Error("window.open returned null")
  return { popup, renderer: (popup as unknown as { renderer: TestRenderer }).renderer }
}

describe.skipIf(!hasNativeTestRenderer)("Solid in another window", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 400, height: 300 })
  })

  afterEach(() => {
    app.unmount()
  })

  it("opens a window with an empty root, from a createRoot root", () => {
    app.render(() => <div>main</div>)
    const { popup, renderer } = openSide()
    expect(popup.document.body.childNodes.length).toBe(0)
    expect(popup.document.body).not.toBe(document.body)
    expect(renderer.getAllText()).toEqual([])
  })

  it("renders a component into the popup's body and returns a dispose", async () => {
    app.render(() => <div>main</div>)
    const { popup, renderer } = openSide()
    const dispose = render(() => <p testId="popup-text">hello popup</p>, popup.document.body as unknown as Element)
    expect(typeof dispose).toBe("function")
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual(["hello popup"])
    expect(app.renderer.getAllText()).toEqual(["main"])
    expect(popup.document.body.querySelector("p")?.textContent).toBe("hello popup")
    dispose()
    await settle(renderer)
    expect(renderer.getAllText()).toEqual([])
    expect(popup.document.body.textContent).toBe("")
  })

  it("keeps a signal of the opener driving both windows", async () => {
    const [count, setCount] = createSignal(0)
    app.render(() => <div>{`main ${count()}`}</div>)
    const { popup, renderer } = openSide()
    render(() => <div>{`popup ${count()}`}</div>, popup.document.body as unknown as Element)
    await settle(renderer)
    expect(renderer.getAllText()).toEqual(["popup 0"])
    setCount(5)
    await settle(renderer, app.renderer)
    expect(app.renderer.getAllText()).toEqual(["main 5"])
    expect(renderer.getAllText()).toEqual(["popup 5"])
  })

  it("delivers the popup's events to its handlers", async () => {
    app.render(() => <div>main</div>)
    const { popup, renderer } = openSide()
    const clicks: string[] = []
    render(
      () => <div testId="button" onClick={() => clicks.push("popup")} style={{ width: 80, height: 30 }} />,
      popup.document.body as unknown as Element
    )
    await settle(renderer)
    const bounds = renderer.getElementBounds(renderer.findByTestId("button")!.id)!
    renderer.nativeSimulateClick(bounds.x + 5, bounds.y + 5)
    expect(clicks).toEqual(["popup"])
  })

  it("provides the popup's own window to useGpuix", async () => {
    const { useGpuix } = await import("../index.js")
    app.render(() => <div>main</div>)
    const { popup, renderer } = openSide()
    let seen: unknown
    render(() => {
      seen = useGpuix()?.renderer
      return <div />
    }, popup.document.body as unknown as Element)
    expect(seen).toBe(renderer)
  })

  it("closing the window unmounts what was rendered in it, running cleanups", async () => {
    app.render(() => <div>main</div>)
    const { popup, renderer } = openSide()
    const log: string[] = []
    render(() => {
      onCleanup(() => log.push("cleanup"))
      return <div>popup</div>
    }, popup.document.body as unknown as Element)
    await settle(renderer)
    popup.close()
    expect(popup.closed).toBe(true)
    // Closing tears down in a later task, as a browser queues it.
    expect(log).toEqual([])
    await settle(app.renderer)
    expect(log).toEqual(["cleanup"])
    expect(app.renderer.getAllText()).toEqual(["main"])
  })

  it("throws a TypeError for the body of a closed window, and does not mount the app again", async () => {
    app.render(() => <div>main</div>)
    const { popup } = openSide()
    const body = popup.document.body as unknown as Element
    render(() => <p>popup</p>, body)
    popup.close()
    await settle(app.renderer)
    const slots = renderSlots().length
    expect(() => render(() => <p>again</p>, popup.document.body as unknown as Element)).toThrow(TypeError)
    expect(() => render(() => <p>again</p>, body)).toThrow(TypeError)
    expect(renderSlots()).toHaveLength(slots)
    expect(app.renderer.getAllText()).toEqual(["main"])
  })

  it("disposes only the nodes its own render put in the element, not another render's, a portal's or the app's", async () => {
    app.render(() => <div>main</div>)
    const { popup, renderer } = openSide()
    const body = popup.document.body as unknown as Element
    const [shownA, setShownA] = createSignal(false)
    const [shownB, setShownB] = createSignal(false)
    const disposeA = render(
      () => (
        <>
          <p>a</p>
          <Show when={shownA()}>
            <p>a later</p>
          </Show>
        </>
      ),
      body
    )
    const disposeB = render(
      () => (
        <>
          <p>b</p>
          <Show when={shownB()}>
            <p>b later</p>
          </Show>
        </>
      ),
      body
    )
    const appNode = popup.document.createElement("p")
    appNode.textContent = "app"
    popup.document.body.appendChild(appNode)
    const [portalShown, setPortalShown] = createSignal(true)
    app.render(() => (
      <div>
        <span>owner</span>
        <Show when={portalShown()}>
          <Portal mount={body as unknown as Node}>
            <p>portal</p>
          </Portal>
        </Show>
      </div>
    ))
    await settle(renderer, app.renderer)
    setShownA(true)
    setShownB(true)
    await settle(renderer)
    expect(renderer.getAllText().sort()).toEqual(["a", "a later", "app", "b", "b later", "portal"])
    disposeA()
    await settle(renderer)
    expect(renderer.getAllText().sort()).toEqual(["app", "b", "b later", "portal"])
    setShownB(false)
    await settle(renderer)
    expect(renderer.getAllText().sort()).toEqual(["app", "b", "portal"])
    disposeB()
    await settle(renderer)
    expect(renderer.getAllText().sort()).toEqual(["app", "portal"])
    setPortalShown(false)
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual(["app"])
  })

  it("unmounts the first window's root when that window goes, while a popup stays open", async () => {
    const log: string[] = []
    const heard: string[] = []
    app.render(() => {
      onCleanup(() => log.push("main cleanup"))
      return <div>main</div>
    })
    const { popup, renderer } = openSide()
    render(() => {
      onCleanup(() => log.push("popup cleanup"))
      return <div>popup</div>
    }, popup.document.body as unknown as Element)
    await settle(renderer, app.renderer)
    for (const type of ["pagehide", "unload"]) window.addEventListener(type, () => heard.push(type), { once: true })
    // What the frame loop does when the user closes the first window and the others stay open.
    app.renderer.dispose()
    expect(heard).toEqual(["pagehide", "unload"])
    expect(log).toEqual(["main cleanup"])
    expect(popup.closed).toBe(false)
    await settle(renderer)
    expect(renderer.getAllText()).toEqual(["popup"])
    // `afterEach` unmounts what the test leaves in `app`.
    app = createTestRoot({ width: 400, height: 300 })
  })

  it("mounts a Portal from the main tree into the popup, following the owner's state", async () => {
    const [text, setText] = createSignal("one")
    const [shown, setShown] = createSignal(true)
    const log: string[] = []
    app.render(() => <div>main</div>)
    const { popup, renderer } = openSide()
    app.render(() => (
      <div>
        <span>owner</span>
        <Show when={shown()}>
          <Portal mount={popup.document.body as unknown as Node}>
            <Portaled text={text} log={log} />
          </Portal>
        </Show>
      </div>
    ))
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual(["one"])
    expect(app.renderer.getAllText().filter(Boolean)).toEqual(["owner"])
    setText("two")
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual(["two"])
    setShown(false)
    await settle(renderer, app.renderer)
    expect(renderer.getAllText()).toEqual([])
    expect(log).toEqual(["portal cleanup"])
  })

  it("lets the popup open a window of its own", () => {
    app.render(() => <div>main</div>)
    const { popup } = openSide()
    const second = popup.open("", "second") as Window | null
    expect(second).not.toBeNull()
    expect(second).not.toBe(popup)
  })

  it("renders into an element of the first window as solid-js/web does, beside what it holds", async () => {
    app.render(() => <div testId="host" />)
    const host = document.querySelector("div") as unknown as Element
    const dispose = render(() => <span>inside</span>, host)
    await settle(app.renderer)
    expect(app.renderer.getAllText()).toEqual(["inside"])
    dispose()
    await settle(app.renderer)
    expect(app.renderer.getAllText()).toEqual([])
  })

  it("keeps a root for each renderer render() is given, and remounts on the same renderer", async () => {
    const first = new TestRenderer({ width: 200, height: 100 })
    const second = new TestRenderer({ width: 200, height: 100 })
    try {
      render(() => <div>first</div>, { renderer: first })
      render(() => <div>second</div>, { renderer: second })
      await settle(first, second)
      expect(first.getAllText()).toEqual(["first"])
      expect(second.getAllText()).toEqual(["second"])
      render(() => <div>first again</div>, { renderer: first })
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
