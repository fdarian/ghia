import { afterEach, beforeEach, describe, expect, it } from "vitest"
import "../dom-globals.js"
import { PopStateEvent, HashChangeEvent } from "../events/classes.js"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("window.location and window.history", () => {
  // The session history is the app's, so every test starts at a new last entry for the initial URL.
  beforeEach(() => {
    history.pushState(null, "", "http://localhost/")
  })

  const heard: Array<Record<string, unknown>> = []
  const onPop = (event: Event) => heard.push({ type: event.type, state: (event as PopStateEvent).state, href: location.href })
  const onHash = (event: Event) => heard.push({ type: event.type, oldURL: (event as HashChangeEvent).oldURL, newURL: (event as HashChangeEvent).newURL })

  afterEach(() => {
    heard.length = 0
    window.removeEventListener("popstate", onPop)
    window.removeEventListener("hashchange", onHash)
    window.onpopstate = null
    window.onhashchange = null
  })

  it("starts at an http origin", () => {
    expect(location.href).toBe("http://localhost/")
    expect(location.origin).toBe("http://localhost")
    expect(location.pathname).toBe("/")
    expect(history.length).toBeGreaterThanOrEqual(1)
    expect(history.state).toBeNull()
    expect(location).toBeInstanceOf(Location)
    expect(history).toBeInstanceOf(History)
    expect(String(location)).toBe(location.href)
    expect(() => new (Location as unknown as new () => object)()).toThrow(TypeError)
  })

  it("pushState adds an entry, resolves the URL against the current one and fires no event", async () => {
    window.addEventListener("popstate", onPop)
    const before = history.length
    history.pushState({ n: 1 }, "", "/a/b?x=1#h")
    expect(location.href).toBe("http://localhost/a/b?x=1#h")
    expect([location.pathname, location.search, location.hash]).toEqual(["/a/b", "?x=1", "#h"])
    expect(history.length).toBe(before + 1)
    history.pushState(null, "", "c")
    expect(location.pathname).toBe("/a/c")
    history.replaceState({ r: true }, "", "/replaced")
    expect(location.pathname).toBe("/replaced")
    expect(history.length).toBe(before + 2)
    await tick()
    expect(heard).toEqual([])
  })

  it("clones the state like a browser", () => {
    const state = { list: [1, 2], nested: { a: 1 } }
    history.pushState(state, "")
    expect(history.state).toEqual(state)
    expect(history.state).not.toBe(state)
    expect(history.state).toBe(history.state)
    state.list.push(3)
    expect((history.state as typeof state).list).toEqual([1, 2])
    expect(() => history.pushState({ f: () => {} }, "")).toThrow(expect.objectContaining({ name: "DataCloneError" }))
  })

  it("refuses a URL of another origin with a SecurityError", () => {
    for (const method of ["pushState", "replaceState"] as const) {
      expect(() => history[method](null, "", "https://example.com/")).toThrow(expect.objectContaining({ name: "SecurityError" }))
      expect(() => history[method](null, "", "http://localhost:8080/")).toThrow(expect.objectContaining({ name: "SecurityError" }))
    }
    expect(location.href).toBe("http://localhost/")
  })

  it("back and forward traverse asynchronously, fire popstate with the state, and discard forward entries on a push", async () => {
    window.addEventListener("popstate", onPop)
    history.pushState({ page: 1 }, "", "/one")
    history.pushState({ page: 2 }, "", "/two")
    history.back()
    expect(location.pathname).toBe("/two")
    await tick()
    expect(location.pathname).toBe("/one")
    expect(history.state).toEqual({ page: 1 })
    expect(heard).toEqual([{ type: "popstate", state: { page: 1 }, href: "http://localhost/one" }])
    history.forward()
    await tick()
    expect(location.pathname).toBe("/two")
    history.go(-2)
    await tick()
    expect(location.pathname).toBe("/")
    expect(history.state).toBeNull()
    history.pushState(null, "", "/three")
    history.forward()
    await tick()
    expect(location.pathname).toBe("/three")
    history.go(-10)
    await tick()
    expect(location.pathname).toBe("/three")
  })

  it("two back() calls go back two entries", async () => {
    history.pushState(null, "", "/one")
    history.pushState(null, "", "/two")
    history.back()
    history.back()
    await tick()
    expect(location.pathname).toBe("/")
  })

  it("go(0) does nothing", async () => {
    window.addEventListener("popstate", onPop)
    history.go(0)
    history.go()
    await tick()
    expect(heard).toEqual([])
  })

  it("fires hashchange after popstate when a traversal changes the fragment", async () => {
    history.pushState(null, "", "/#a")
    window.addEventListener("popstate", onPop)
    window.addEventListener("hashchange", onHash)
    history.back()
    await tick()
    expect(heard.map((entry) => entry.type)).toEqual(["popstate", "hashchange"])
    expect(heard[1]).toEqual({ type: "hashchange", oldURL: "http://localhost/#a", newURL: "http://localhost/" })
    heard.length = 0
    history.pushState(null, "", "/other")
    history.pushState(null, "", "/other2")
    history.back()
    await tick()
    expect(heard.map((entry) => entry.type)).toEqual(["popstate"])
  })

  it("delivers PopStateEvent and HashChangeEvent that do not bubble, to onpopstate too", async () => {
    const seen: Event[] = []
    window.onpopstate = (event) => seen.push(event)
    window.onhashchange = (event) => seen.push(event)
    history.pushState({ s: 1 }, "", "/#x")
    history.back()
    await tick()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBeInstanceOf(PopStateEvent)
    expect(seen[1]).toBeInstanceOf(HashChangeEvent)
    expect(seen[0].bubbles).toBe(false)
    expect(seen[0].target).toBe(globalThis)
    expect(window.onpopstate).toBeTypeOf("function")
    window.onpopstate = null
    expect(window.onpopstate).toBeNull()
  })

  it("keeps scrollRestoration", () => {
    expect(history.scrollRestoration).toBe("auto")
    history.scrollRestoration = "manual"
    expect(history.scrollRestoration).toBe("manual")
    history.scrollRestoration = "bogus" as "auto"
    expect(history.scrollRestoration).toBe("manual")
    history.scrollRestoration = "auto"
  })

  it("a fragment navigation adds an entry, or replaces it for replace(), and fires popstate then hashchange", async () => {
    window.addEventListener("popstate", onPop)
    window.addEventListener("hashchange", onHash)
    const before = history.length
    location.hash = "top"
    expect(location.href).toBe("http://localhost/#top")
    expect(history.length).toBe(before + 1)
    expect(heard).toEqual([])
    await tick()
    expect(heard).toEqual([
      { type: "popstate", state: null, href: "http://localhost/#top" },
      { type: "hashchange", oldURL: "http://localhost/", newURL: "http://localhost/#top" },
    ])
    location.replace("#next")
    expect(history.length).toBe(before + 1)
    expect(location.hash).toBe("#next")
    location.assign("/#third")
    expect(history.length).toBe(before + 2)
    location.href = "#fourth"
    expect(history.length).toBe(before + 3)
    location.hash = ""
    expect(location.href).toBe("http://localhost/#")
    expect(location.hash).toBe("")
    await tick()
    heard.length = 0
    location.hash = "#"
    await tick()
    expect(heard).toEqual([])
  })

  it("throws NotSupportedError for a navigation that would load a document, and for reload", () => {
    const refused = expect.objectContaining({ name: "NotSupportedError", message: expect.stringContaining("history.pushState") })
    expect(() => (location.href = "/elsewhere")).toThrow(refused)
    expect(() => location.assign("http://example.com/")).toThrow(refused)
    expect(() => location.replace("?q=1")).toThrow(refused)
    expect(() => (location.pathname = "/x")).toThrow(refused)
    expect(() => (location.search = "?a")).toThrow(refused)
    expect(() => location.reload()).toThrow(refused)
    expect(location.href).toBe("http://localhost/")
  })

  it("throws SyntaxError for a URL that does not parse", () => {
    expect(() => location.assign("http://")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
  })

  it("setting window.location navigates like location.href", () => {
    history.pushState(null, "", "/p")
    ;(window as unknown as { location: string }).location = "#frag"
    expect(location.href).toBe("http://localhost/p#frag")
  })
})
