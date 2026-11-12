import { ErrorBoundary, Show, Switch, Match, createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const WARNING = "Unrecognized value. Skipped inserting"

// What a Solid component renders after it threw on mount in dev: solid-refresh 0.6.3 passes
// `{ name }` as the memo's initial value, and the memo never computed.
function Bomb(): JSX.Element {
  return { name: "[solid-refresh]Bomb" } as unknown as JSX.Element
}

function Thrower(): JSX.Element {
  throw new Error("boom")
}

const texts = (renderer: TestRenderer) => renderer.getAllText()

describe.skipIf(!hasNativeTestRenderer)("Solid renders a value that is not a host node", () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it("skips it with a warning, and a later page shows", async () => {
    const [page, setPage] = createSignal<"bomb" | "text">("bomb")
    const app = createTestRoot()
    app.render(() => (
      <div>
        <Show when={page()} keyed>
          {(current) => (current === "bomb" ? <Bomb /> : <div testId="text-page">Text page</div>)}
        </Show>
      </div>
    ))
    expect(warn).toHaveBeenCalledWith(WARNING, { name: "[solid-refresh]Bomb" })
    const withBomb = app.renderer.getRetainedElementCount()
    setPage("text")
    await tick()
    await tick()
    expect(texts(app.renderer)).toContain("Text page")
    expect(app.renderer.findByTestId("text-page")).toBeDefined()

    // The skipped value left no element behind: the counts are those of the same pages built directly.
    const controlBomb = createTestRoot()
    controlBomb.render(() => <div />)
    expect(withBomb).toBe(controlBomb.renderer.getRetainedElementCount())
    const controlText = createTestRoot()
    controlText.render(() => (
      <div>
        <div testId="text-page">Text page</div>
      </div>
    ))
    expect(app.renderer.getRetainedElementCount()).toBe(controlText.renderer.getRetainedElementCount())
  })

  it("skips it in a Switch that a signal moves on to another view", async () => {
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
    await tick()
    await tick()
    expect(app.renderer.findByTestId("text-page")).toBeDefined()
    setPage(2)
    await tick()
    await tick()
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
    const children = () => app.renderer.getAllText().filter((text) => text !== "")
    expect(children()).toEqual(["first", "marker"])

    setView("node")
    await tick()
    await tick()
    expect(children()).toEqual(["first", "middle", "marker"])

    setView("none")
    await tick()
    await tick()
    expect(children()).toEqual(["first", "marker"])

    setView("bomb")
    await tick()
    await tick()
    expect(children()).toEqual(["first", "marker"])
    setView("node")
    await tick()
    await tick()
    expect(children()).toEqual(["first", "middle", "marker"])
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
    await tick()
    await tick()
    expect(app.renderer.findByTestId("fallback")).toBeUndefined()
    expect(texts(app.renderer)).toContain("Text page")
  })
})
