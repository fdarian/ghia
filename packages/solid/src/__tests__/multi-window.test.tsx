/**
 * Solid renders into other windows the web way: `window.open('')` gives an empty root (the adapter's
 * window factory), `render(code, w.document.body)` mounts there, and a `Portal` can mount in it.
 */
import { createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render } from "../index.js"
import { createTestRoot, hasNativeTestRenderer, type TestRenderer } from "../testing.js"

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
    expect(log).toEqual(["cleanup"])
    expect(popup.closed).toBe(true)
    await settle(app.renderer)
    expect(app.renderer.getAllText()).toEqual(["main"])
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
})
