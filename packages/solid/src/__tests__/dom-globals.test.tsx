/**
 * Importing `@ghia/native/host` makes `window` the global object, so code written for the
 * web (`window.addEventListener("keydown", ...)`, a router calling `scrollTo`) runs
 * unchanged, while Bun's own events still reach the same global listeners.
 */
import { afterEach, describe, expect, it } from "vitest"
import { document, isWebBuild } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe("dom globals", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function listen(type: string, listener: (event: any) => void) {
    globalThis.addEventListener(type, listener)
    cleanups.push(() => globalThis.removeEventListener(type, listener))
  }

  it("makes window the global object and document Ghia's", () => {
    expect(isWebBuild).toBe(false)
    expect(typeof window).not.toBe("undefined")
    expect(window).toBe(globalThis)
    expect(globalThis.document).toBe(document)
    expect(window.document).toBe(document)
  })

  it("has scrollTo, scroll and scrollBy that do nothing", () => {
    expect(window.scrollTo(0, 100)).toBeUndefined()
    expect(window.scroll({ top: 10 })).toBeUndefined()
    expect(window.scrollBy(0, 10)).toBeUndefined()
  })

  it("still delivers a dispatched event to a global listener exactly once", () => {
    const seen: string[] = []
    listen("error", (event) => seen.push(event.type))
    listen("ghia-custom", (event) => seen.push(event.detail))
    globalThis.dispatchEvent(new ErrorEvent("error", { message: "boom" }))
    globalThis.dispatchEvent(new CustomEvent("ghia-custom", { detail: "payload" }))
    expect(seen).toEqual(["error", "payload"])
  })

  it("stops delivering once the listener is removed", () => {
    const seen: string[] = []
    const listener = (event: Event) => seen.push(event.type)
    globalThis.addEventListener("ghia-custom", listener)
    globalThis.dispatchEvent(new Event("ghia-custom"))
    globalThis.removeEventListener("ghia-custom", listener)
    globalThis.dispatchEvent(new Event("ghia-custom"))
    expect(seen).toEqual(["ghia-custom"])
  })

  it("keeps the same functions when the module is evaluated again", async () => {
    const add = globalThis.addEventListener
    await import("../../../native/dist/dom-globals.js?again")
    expect(globalThis.addEventListener).toBe(add)
  })

  describe.skipIf(!hasNativeTestRenderer)("with a window", () => {
    function mount() {
      const app = createTestRoot()
      app.render(() => (
        <div style={{ width: 200, height: 100 }}>
          <div testId="target" tabIndex={0} style={{ width: 40, height: 20 }} />
        </div>
      ))
      const id = app.renderer.findByTestId("target")!.id
      cleanups.push(() => app.unmount())
      return (keys: string) => app.renderer.nativeSimulateKeystrokes(id, keys)
    }

    it("hears a key sent through Ghia on a global keydown listener, until removed", () => {
      const press = mount()
      const keys: string[] = []
      const listener = (event: KeyboardEvent) => keys.push(event.key)
      globalThis.addEventListener("keydown", listener as EventListener)
      press("x")
      globalThis.removeEventListener("keydown", listener as EventListener)
      press("y")
      expect(keys).toEqual(["x"])
    })

    it("hears it through window.addEventListener too", () => {
      const press = mount()
      const keys: string[] = []
      const listener = (event: KeyboardEvent) => keys.push(event.key)
      window.addEventListener("keydown", listener as EventListener)
      cleanups.push(() => window.removeEventListener("keydown", listener as EventListener))
      press("x")
      expect(keys).toEqual(["x"])
    })
  })
})
