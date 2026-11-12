import { ErrorBoundary, For, Show, Switch, Match, createMemo, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { ElementListeners } from "@ghia/native/host"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostRoot } from "../host.js"
import { createRoot } from "../root.js"
import { TestRenderer, createTestRoot, hasNativeTestRenderer } from "../testing.js"

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const WARNING = "Unrecognized value. Rendered nothing in its place"

// What a Solid component renders after it threw on mount in dev. solid-refresh 0.6.3 calls
// `createMemo(fn, { name })`, and solid-js 1.9 takes the second argument as the memo's initial
// value, so a memo whose `fn` throws on its first run keeps `{ name }` as its value.
function RefreshBomb(): JSX.Element {
  return createMemo(
    () => {
      throw new Error("boom")
    },
    { name: "[solid-refresh]Bomb" } as never
  )
}

// The same object, handed over directly.
function Bomb(): JSX.Element {
  return { name: "[solid-refresh]Bomb" } as unknown as JSX.Element
}

function Thrower(): JSX.Element {
  throw new Error("boom")
}

const texts = (renderer: TestRenderer) => renderer.getAllText()
const shown = (renderer: TestRenderer) => texts(renderer).filter((text) => text !== "")

async function settle(): Promise<void> {
  await tick()
  await tick()
}

describe.skipIf(!hasNativeTestRenderer)("Solid renders a value that is not a host node", () => {
  let warn: ReturnType<typeof vi.spyOn>
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    error = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    expect(error).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it("renders nothing in its place and warns once, and a later page shows", async () => {
    const [page, setPage] = createSignal<"bomb" | "text">("bomb")
    const app = createTestRoot()
    app.render(() => (
      <div>
        <Show when={page()} keyed>
          {(current) => (current === "bomb" ? <Bomb /> : <div testId="text-page">Text page</div>)}
        </Show>
      </div>
    ))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(WARNING, { name: "[solid-refresh]Bomb" })
    expect(shown(app.renderer)).toEqual([])
    setPage("text")
    await settle()
    expect(shown(app.renderer)).toEqual(["Text page"])
    expect(app.renderer.findByTestId("text-page")).toBeDefined()

    // The placeholder is released with the page: the same count as the page built directly.
    const control = createTestRoot()
    control.render(() => (
      <div>
        <div testId="text-page">Text page</div>
      </div>
    ))
    expect(app.renderer.getRetainedElementCount()).toBe(control.renderer.getRetainedElementCount())
  })

  it("holds one empty text node for the object while it is shown", () => {
    const app = createTestRoot()
    app.render(() => <div />)
    const bare = app.renderer.getRetainedElementCount()
    const withBomb = createTestRoot()
    withBomb.render(() => (
      <div>
        <Bomb />
      </div>
    ))
    expect(withBomb.renderer.getRetainedElementCount()).toBe(bare + 1)
  })

  it("does the same for a component that throws on mount the way solid-refresh makes it, inside an ErrorBoundary", async () => {
    const [page, setPage] = createSignal<"bomb" | "text">("bomb")
    const app = createTestRoot()
    app.render(() => (
      <div>
        <Show when={page()} keyed>
          {(current) =>
            current === "bomb" ? (
              <ErrorBoundary fallback={(error) => <div testId="fallback">{String(error.message)}</div>}>
                <RefreshBomb />
              </ErrorBoundary>
            ) : (
              <div testId="text-page">Text page</div>
            )
          }
        </Show>
      </div>
    ))
    expect(warn).toHaveBeenCalledWith(WARNING, { name: "[solid-refresh]Bomb" })
    expect(app.renderer.findByTestId("fallback")).toBeDefined()
    expect(shown(app.renderer)).toEqual(["boom"])

    setPage("text")
    await settle()
    expect(app.renderer.findByTestId("fallback")).toBeUndefined()
    expect(shown(app.renderer)).toEqual(["Text page"])

    setPage("bomb")
    await settle()
    expect(shown(app.renderer)).toEqual(["boom"])
  })

  it("keeps an object shown in two roots as one node in each", async () => {
    const shared = { name: "shared" }
    const [on, setOn] = createSignal(true)
    const view = () => (
      <div>
        <Show when={on()}>{shared as unknown as JSX.Element}</Show>
      </div>
    )
    const bare = createTestRoot()
    bare.render(() => <div />)
    const first = createTestRoot()
    first.render(view)
    const second = createTestRoot()
    second.render(view)
    const withPlaceholder = bare.renderer.getRetainedElementCount() + 1
    expect(first.renderer.getRetainedElementCount()).toBe(withPlaceholder)
    expect(second.renderer.getRetainedElementCount()).toBe(withPlaceholder)

    setOn(false)
    await settle()
    expect(first.renderer.getRetainedElementCount()).toBe(withPlaceholder - 1)
    expect(second.renderer.getRetainedElementCount()).toBe(withPlaceholder - 1)
    setOn(true)
    await settle()
    expect(first.renderer.getRetainedElementCount()).toBe(withPlaceholder)
    expect(second.renderer.getRetainedElementCount()).toBe(withPlaceholder)
    first.unmount()
    second.unmount()
  })

  it("renders nothing for a value with `kind: \"text\"` that is not a host node", async () => {
    const [view, setView] = createSignal<"ast" | "node">("ast")
    const ast = { kind: "text", value: "hello" }
    const app = createTestRoot()
    app.render(() => (
      <div>
        <div>first</div>
        <Show when={view() === "ast"} fallback={<div>node</div>}>
          {ast as unknown as JSX.Element}
        </Show>
        <div>marker</div>
      </div>
    ))
    expect(warn).toHaveBeenCalledWith(WARNING, ast)
    expect(shown(app.renderer)).toEqual(["first", "marker"])
    setView("node")
    await settle()
    expect(shown(app.renderer)).toEqual(["first", "node", "marker"])
  })

  it("warns once for an object however often it is shown again", async () => {
    const [on, setOn] = createSignal(true)
    const object = { name: "again" }
    const app = createTestRoot()
    app.render(() => (
      <div>
        <Show when={on()}>{object as unknown as JSX.Element}</Show>
      </div>
    ))
    setOn(false)
    await settle()
    setOn(true)
    await settle()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("renders nothing in a Switch that a signal moves on to another view", async () => {
    const [page, setPage] = createSignal(0)
    const app = createTestRoot()
    app.render(() => (
      <Switch>
        <Match when={page() === 0}>
          <Bomb />
        </Match>
        <Match when={page() === 1}>
          <div testId="text-page">Text page</div>
        </Match>
      </Switch>
    ))
    expect(warn).toHaveBeenCalledWith(WARNING, { name: "[solid-refresh]Bomb" })
    setPage(1)
    await settle()
    expect(app.renderer.findByTestId("text-page")).toBeDefined()
    setPage(2)
    await settle()
    expect(app.renderer.findByTestId("text-page")).toBeUndefined()
  })

  it("leaves the positions of its siblings right when the view around it changes", async () => {
    const [view, setView] = createSignal<"bomb" | "node" | "none">("bomb")
    const app = createTestRoot()
    app.render(() => (
      <div testId="list">
        <div>first</div>
        <Show when={view() !== "none"}>
          {view() === "bomb" ? <Bomb /> : <div>middle</div>}
        </Show>
        <div>marker</div>
      </div>
    ))
    expect(shown(app.renderer)).toEqual(["first", "marker"])

    setView("node")
    await settle()
    expect(shown(app.renderer)).toEqual(["first", "middle", "marker"])

    setView("none")
    await settle()
    expect(shown(app.renderer)).toEqual(["first", "marker"])

    setView("bomb")
    await settle()
    expect(shown(app.renderer)).toEqual(["first", "marker"])
    setView("node")
    await settle()
    expect(shown(app.renderer)).toEqual(["first", "middle", "marker"])
  })

  it("puts a fragment that replaces it before the nodes after it", async () => {
    const [bomb, setBomb] = createSignal(true)
    const app = createTestRoot()
    app.render(() => (
      <div>
        <div>first</div>
        <Show when>
          {bomb() ? (
            <Bomb />
          ) : (
            <>
              <div>a</div>
              <div>b</div>
            </>
          )}
        </Show>
        <div>marker</div>
      </div>
    ))
    expect(shown(app.renderer)).toEqual(["first", "marker"])
    setBomb(false)
    await settle()
    expect(shown(app.renderer)).toEqual(["first", "a", "b", "marker"])
    setBomb(true)
    await settle()
    expect(shown(app.renderer)).toEqual(["first", "marker"])
  })

  it("keeps the rows of a list around it in order when rows are added", async () => {
    const [items, setItems] = createSignal(["x", "bomb", "y"])
    const app = createTestRoot()
    app.render(() => (
      <div>
        <For each={items()}>{(item) => (item === "bomb" ? <Bomb /> : <div>{item}</div>)}</For>
        <div>footer</div>
      </div>
    ))
    expect(shown(app.renderer)).toEqual(["x", "y", "footer"])

    setItems(["p", "x", "bomb", "y"])
    await settle()
    expect(shown(app.renderer)).toEqual(["p", "x", "y", "footer"])

    setItems(["p", "x", "bomb", "y", "z"])
    await settle()
    expect(shown(app.renderer)).toEqual(["p", "x", "y", "z", "footer"])

    setItems(["p", "x", "y", "z"])
    await settle()
    expect(shown(app.renderer)).toEqual(["p", "x", "y", "z", "footer"])

    setItems(["bomb", "p", "x", "y", "z"])
    await settle()
    expect(shown(app.renderer)).toEqual(["p", "x", "y", "z", "footer"])
  })

  it("shows the fallback of an ErrorBoundary around a component that throws on mount, then the next page", async () => {
    const [page, setPage] = createSignal<"error" | "text">("error")
    const app = createTestRoot()
    app.render(() => (
      <div>
        <Show when={page()} keyed>
          {(current) =>
            current === "error" ? (
              <ErrorBoundary fallback={(error) => <div testId="fallback">{String(error.message)}</div>}>
                <Thrower />
              </ErrorBoundary>
            ) : (
              <div testId="text-page">Text page</div>
            )
          }
        </Show>
      </div>
    ))
    expect(app.renderer.findByTestId("fallback")).toBeDefined()
    expect(texts(app.renderer)).toContain("boom")

    setPage("text")
    await settle()
    expect(app.renderer.findByTestId("fallback")).toBeUndefined()
    expect(texts(app.renderer)).toContain("Text page")
  })
})

describe.skipIf(!hasNativeTestRenderer)("Solid reports an error thrown while a frame's changes are flushed", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Armed once the mount's own flush has run, so it is the next microtask flush that throws.
  async function mountedWithThrowingRemoval(
    root: { render(code: () => JSX.Element): void; renderer: TestRenderer },
    boom: Error
  ) {
    const [text, setText] = createSignal("first")
    root.render(() => <div>{text()}</div>)
    await tick()
    vi.spyOn(HostRoot.prototype, "finishRemovals").mockImplementationOnce(() => {
      throw boom
    })
    return setText
  }

  it("gives the error to onUncaughtError and still shows later updates", async () => {
    const renderer = new TestRenderer({})
    const onUncaughtError = vi.fn()
    const root = createRoot(renderer, { onUncaughtError })
    const boom = new Error("removal failed")
    const setText = await mountedWithThrowingRemoval(
      { render: (code) => root.render(code), renderer },
      boom
    )

    setText("second")
    await tick()
    expect(onUncaughtError).toHaveBeenCalledTimes(1)
    expect(onUncaughtError.mock.calls[0]?.[0]).toBe(boom)
    renderer.flush()
    expect(texts(renderer)).toContain("second")

    setText("third")
    await tick()
    renderer.flush()
    expect(texts(renderer)).toContain("third")
    root.unmount()
    renderer.flush()
    renderer.dispose()
  })

  it("logs the error with console.error when the root has no onUncaughtError", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const app = createTestRoot()
    const boom = new Error("removal failed")
    const setText = await mountedWithThrowingRemoval(app, boom)

    setText("second")
    await tick()
    expect(error).toHaveBeenCalledWith(boom)
    app.renderer.flush()
    expect(texts(app.renderer)).toContain("second")
    app.unmount()
  })

  it("rethrows a release error from a synchronous flush after the batch was still flushed", async () => {
    const app = createTestRoot()
    const boom = new Error("removal failed")
    const setText = await mountedWithThrowingRemoval(app, boom)

    setText("second")
    expect(() => app.root.flush()).toThrow(boom)
    app.renderer.flush()
    expect(texts(app.renderer)).toContain("second")
    app.unmount()
  })

  it("finishes tearing down before it rethrows the error of an unmount", async () => {
    const app = createTestRoot()
    const boom = new Error("removal failed")
    app.render(() => <div>content</div>)
    await tick()
    vi.spyOn(HostRoot.prototype, "finishRemovals").mockImplementationOnce(() => {
      throw boom
    })

    expect(() => app.unmount()).toThrow(boom)
    app.renderer.flush()
    expect(app.renderer.getRetainedElementCount()).toBe(0)
  })
})

describe.skipIf(!hasNativeTestRenderer)("Solid keeps tearing down after a throw", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders the next tree when an onCleanup threw while the previous one was disposed", () => {
    const app = createTestRoot()
    const boom = new Error("cleanup failed")
    app.render(() => {
      onCleanup(() => {
        throw boom
      })
      return <div>old</div>
    })
    expect(() => app.render(() => <div>new</div>)).toThrow(boom)

    app.render(() => <div>new</div>)
    expect(shown(app.renderer)).toEqual(["new"])
    app.unmount()
  })

  it("throws an AggregateError from flushSync when both the function and the flush throw", async () => {
    const app = createTestRoot()
    app.render(() => <div>content</div>)
    await tick()
    const inFunction = new Error("in function")
    const inFlush = new Error("in flush")
    vi.spyOn(HostRoot.prototype, "finishRemovals").mockImplementationOnce(() => {
      throw inFlush
    })
    let caught: unknown
    try {
      app.root.flushSync(() => {
        throw inFunction
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([inFunction, inFlush])
    app.unmount()
  })

  it("destroys a removed subtree's elements although marking it unmounted threw", async () => {
    const boom = new Error("detach failed")
    const [on, setOn] = createSignal(true)
    const onUncaughtError = vi.fn()
    const renderer = new TestRenderer({})
    const root = createRoot(renderer, { onUncaughtError })
    const bare = createTestRoot()
    bare.render(() => <div />)
    root.render(() => (
      <div>
        <Show when={on()}>
          <div>
            <div>inner</div>
          </div>
        </Show>
      </div>
    ))
    await tick()
    renderer.flush()
    vi.spyOn(ElementListeners.prototype, "detach").mockImplementationOnce(() => {
      throw boom
    })

    setOn(false)
    await tick()
    renderer.flush()
    expect(onUncaughtError.mock.calls[0]?.[0]).toBe(boom)
    expect(renderer.getRetainedElementCount()).toBe(bare.renderer.getRetainedElementCount())
    root.unmount()
    renderer.dispose()
    bare.unmount()
  })
})
