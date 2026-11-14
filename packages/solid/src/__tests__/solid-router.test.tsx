/**
 * `@solidjs/router` publishes its JSX source under the `solid` condition and imports the server-only API
 * (`getRequestEvent`, `delegateEvents`) from solid-js/web, so it runs only because `@ghia/solid/web` has it.
 * It also reads `window.history` when it is imported, which Ghia has no `history` for yet: `solid-router-history.test.tsx`
 * pins that, and this file gives the router the smallest stand-in so the rest runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import type { JSX } from "solid-js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const standIn = {
  state: null as unknown,
  length: 1,
  replaceState(state: unknown) {
    this.state = state
  },
}

describe.skipIf(!hasNativeTestRenderer)("@solidjs/router from source on Ghia", () => {
  let router: typeof import("@solidjs/router")
  let app: ReturnType<typeof createTestRoot> | undefined

  beforeAll(async () => {
    Object.defineProperty(globalThis.window, "history", { value: standIn, configurable: true })
    router = await import("@solidjs/router")
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis.window, "history")
  })

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  // The router navigates inside a transition, which commits after a microtask.
  async function settled() {
    await new Promise((resolve) => setTimeout(resolve, 0))
    app!.flushSync(() => {})
  }

  it("renders the route a MemoryRouter is at and navigates between two", async () => {
    app = createTestRoot({ width: 400, height: 300 })
    let navigate!: (path: string) => void
    function Layout(props: { children?: JSX.Element }) {
      const go = router.useNavigate()
      navigate = (path) => go(path)
      return <div>{props.children}</div>
    }
    const history = router.createMemoryHistory()
    app.render(() => (
      <router.MemoryRouter history={history} root={Layout}>
        <router.Route path="/" component={() => <h1>home</h1>} />
        <router.Route path="/about" component={() => <h2>about</h2>} />
      </router.MemoryRouter>
    ))
    expect(app.renderer.getAllText().join("")).toBe("home")
    navigate("/about")
    await settled()
    expect(app.renderer.getAllText().join("")).toBe("about")
    navigate("/")
    await settled()
    expect(app.renderer.getAllText().join("")).toBe("home")
  })
})
