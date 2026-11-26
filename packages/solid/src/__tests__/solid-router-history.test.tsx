/**
 * `@solidjs/router`'s `<Router>` runs on `window.location` and `window.history`, which Ghia has: it reads `history.state`
 * when it is imported, navigates with `pushState` and goes back on `popstate`.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import type { JSX } from "solid-js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("@solidjs/router's <Router> on window.history", () => {
  let router: typeof import("@solidjs/router")
  let app: ReturnType<typeof createTestRoot> | undefined

  beforeAll(async () => {
    router = await import("@solidjs/router")
  })

  afterEach(() => {
    app?.unmount()
    app = undefined
    history.replaceState(null, "", "/")
  })

  async function settled() {
    await new Promise((resolve) => setTimeout(resolve, 0))
    app!.flushSync(() => {})
  }

  it("renders the route of location, navigates with useNavigate and goes back", async () => {
    history.replaceState(null, "", "/")
    const entries = history.length
    app = createTestRoot({ width: 400, height: 300 })
    let navigate!: (path: string) => void
    function Layout(props: { children?: JSX.Element }) {
      const go = router.useNavigate()
      navigate = (path) => go(path)
      return <div>{props.children}</div>
    }
    app.render(() => (
      <router.Router root={Layout}>
        <router.Route path="/" component={() => <h1>home</h1>} />
        <router.Route path="/about" component={() => <h2>about</h2>} />
      </router.Router>
    ))
    expect(app.renderer.getAllText().join("")).toBe("home")

    navigate("/about")
    await settled()
    expect(location.pathname).toBe("/about")
    expect(history.length).toBe(entries + 1)
    expect(app.renderer.getAllText().join("")).toBe("about")

    history.back()
    await settled()
    expect(location.pathname).toBe("/")
    expect(app.renderer.getAllText().join("")).toBe("home")

    history.forward()
    await settled()
    expect(app.renderer.getAllText().join("")).toBe("about")
  })

  it("renders the route a page is opened at", async () => {
    history.replaceState(null, "", "/about")
    app = createTestRoot({ width: 400, height: 300 })
    app.render(() => (
      <router.Router>
        <router.Route path="/" component={() => <h1>home</h1>} />
        <router.Route path="/about" component={() => <h2>about</h2>} />
      </router.Router>
    ))
    expect(app.renderer.getAllText().join("")).toBe("about")
  })
})
