import { afterEach, describe, expect, it, vi } from "vitest"
import { document, window as ghiaWindow } from "../events/window-target.js"
import "../dom-globals.js"
import { isWebBuild } from "../web-build.js"

describe("dom globals of the native build", () => {
  const listener = () => {}

  afterEach(() => {
    globalThis.removeEventListener("keydown", listener)
  })

  it("is not the web build", () => {
    expect(isWebBuild).toBe(false)
  })

  it("makes window the global object and document Ghia's document", () => {
    expect(typeof window).not.toBe("undefined")
    expect(window).toBe(globalThis)
    expect(globalThis.document).toBe(document)
    expect(window.document).toBe(document)
  })

  it("has requestAnimationFrame, cancelAnimationFrame and ResizeObserver, and a document whose view is the window", () => {
    expect(typeof globalThis.requestAnimationFrame).toBe("function")
    expect(typeof globalThis.cancelAnimationFrame).toBe("function")
    expect(typeof globalThis.ResizeObserver).toBe("function")
    expect(document.defaultView).toBe(globalThis)
  })

  it("turns scrolling the viewport into a no-op", () => {
    expect(window.scrollTo(0, 100)).toBeUndefined()
    expect(window.scroll({ top: 10 })).toBeUndefined()
    expect(window.scrollBy(0, 10)).toBeUndefined()
  })

  it("registers a global listener with Ghia's window, until it is removed", () => {
    expect(ghiaWindow.hasListeners("keydown")).toBe(false)
    globalThis.addEventListener("keydown", listener)
    expect(ghiaWindow.hasListeners("keydown")).toBe(true)
    globalThis.removeEventListener("keydown", listener)
    expect(ghiaWindow.hasListeners("keydown")).toBe(false)
  })

  it("installs once however often the module is evaluated", async () => {
    const add = globalThis.addEventListener
    vi.resetModules()
    await import("../dom-globals.js")
    expect(globalThis.addEventListener).toBe(add)
  })
})
