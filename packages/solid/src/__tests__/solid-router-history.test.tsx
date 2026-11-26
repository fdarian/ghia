/**
 * `@solidjs/router`'s `<Router>` runs on `window.location` and `window.history`, which Ghia has: it reads `history.state`
 * when it is imported, navigates with `pushState` and goes back on `popstate`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
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

  describe("clicking a link", () => {
    const linkStyle = { display: "block", width: 120, height: 24 }

    function mountLinks(links: (router: typeof import("@solidjs/router")) => JSX.Element) {
      history.replaceState(null, "", "/")
      app = createTestRoot({ width: 400, height: 300 })
      app.render(() => (
        <router.Router
          root={(props: { children?: JSX.Element }) => (
            <div>
              {links(router)}
              {props.children}
            </div>
          )}
        >
          <router.Route path="/" component={() => <h1>home</h1>} />
          <router.Route path="/b" component={() => <h2>b</h2>} />
        </router.Router>
      ))
      app.renderer.flush()
    }

    async function clickAt(x: number, y: number) {
      app!.renderer.nativeSimulateClick(x, y)
      await settled()
    }

    it("navigates on a click on an <A href> and goes back", async () => {
      mountLinks((r) => <r.A href="/b" style={linkStyle}>to b</r.A>)
      const entries = history.length
      await clickAt(10, 10)
      expect(location.pathname).toBe("/b")
      expect(history.length).toBe(entries + 1)
      expect(app!.renderer.getAllText().join("")).toContain("b")
      expect(app!.renderer.getAllText().join("")).not.toContain("home")

      history.back()
      await settled()
      expect(location.pathname).toBe("/")
      expect(app!.renderer.getAllText().join("")).toContain("home")
    })

    it("navigates on a click on a plain <a href>", async () => {
      mountLinks(() => <a href="/b" style={linkStyle}>to b</a>)
      await clickAt(10, 10)
      expect(location.pathname).toBe("/b")
      expect(app!.renderer.getAllText().join("")).not.toContain("home")

      history.back()
      await settled()
      expect(location.pathname).toBe("/")
      expect(app!.renderer.getAllText().join("")).toContain("home")
    })

    it("a link the router leaves alone is followed by the default action: a fragment navigates, another origin only warns", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        mountLinks(() => (
          <>
            <a href="#section" rel="external" style={linkStyle}>fragment</a>
            <a href="https://example.com/x" style={linkStyle}>elsewhere</a>
          </>
        ))
        await clickAt(10, 10)
        expect(location.hash).toBe("#section")
        expect(location.pathname).toBe("/")
        await clickAt(10, 36)
        expect(location.href).toBe("http://localhost/#section")
        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0]![0])).toContain("https://example.com/x")
      } finally {
        warn.mockRestore()
      }
    })

    it("el.click() on a link navigates like a pointer click", async () => {
      let link!: HTMLAnchorElement
      mountLinks(() => <a ref={link} href="/b" style={linkStyle}>to b</a>)
      link.click()
      await settled()
      expect(location.pathname).toBe("/b")
    })
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
