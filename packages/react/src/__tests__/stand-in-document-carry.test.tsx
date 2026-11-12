/**
 * Before the first root exists the document's `<html>`, `<head>` and `<body>` are stand-ins (`dom/stand-in-document.ts`).
 * What code wrote to them (`classList`, `dataset`, `style`, a listener) is written again to the elements of the first
 * root, and the stand-ins are then in no document.
 */
import { afterEach, describe, expect, it } from "vitest"
import { document, getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("stand-in document elements, carried onto the first root in React", () => {
  let app: TestRoot | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  function mount(ui: React.ReactNode = <div style={{ width: 40, height: 20 }} />): TestRoot {
    app = createTestRoot({ width: 400, height: 300 })
    app.render(ui)
    return app
  }

  it("keeps a class set on <html> before render", () => {
    document.documentElement.setAttribute("class", "dark")
    mount()
    expect(document.documentElement.hasAttribute("class")).toBe(true)
    expect(document.documentElement.getAttribute("class")).toBe("dark")
  })

  it("keeps data attributes and dataset writes", () => {
    document.documentElement.dataset.theme = "ink"
    document.body.setAttribute("data-page", "home")
    mount()
    expect(document.documentElement.dataset.theme).toBe("ink")
    expect(document.documentElement.getAttribute("data-theme")).toBe("ink")
    expect(document.body.getAttribute("data-page")).toBe("home")
  })

  it("keeps style written to <html> and <body>", () => {
    document.documentElement.style.colorScheme = "dark"
    document.body.style.opacity = "0.5"
    mount()
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(document.body.style.opacity).toBe("0.5")
    expect(getComputedStyle(document.body).opacity).toBe("0.5")
  })

  it("lets a class on <html> drive a rule of a <style> in the app", () => {
    document.documentElement.setAttribute("class", "dark")
    mount(
      <div>
        <style>{"html.dark body { opacity: 0.25 }"}</style>
        <div style={{ width: 40, height: 20 }} />
      </div>
    )
    expect(getComputedStyle(document.body).opacity).toBe("0.25")
    document.documentElement.removeAttribute("class")
    app!.renderer.flush()
    expect(getComputedStyle(document.body).opacity).toBe("1")
  })

  it("fires listeners added to <body> before render, with their options", () => {
    const seen: string[] = []
    document.body.addEventListener("keydown", (event) => seen.push(`bubble ${event.type}`))
    document.body.addEventListener("keydown", (event) => seen.push(`capture ${event.type}`), { capture: true })
    document.body.addEventListener("keydown", () => seen.push("once"), { once: true })
    mount()
    document.body.dispatchEvent(new Event("keydown", { bubbles: true }))
    document.body.dispatchEvent(new Event("keydown", { bubbles: true }))
    expect(seen).toEqual(["capture keydown", "bubble keydown", "once", "capture keydown", "bubble keydown"])
  })

  it("fires a keydown listener added to <body> before render on a key press", () => {
    let pressed = 0
    document.body.addEventListener("keydown", () => (pressed += 1))
    let button: HTMLElement | null = null
    mount(<button ref={(element) => (button = element as unknown as HTMLElement | null) ?? button} style={{ width: 60, height: 24 }}>Go</button>)
    button!.focus()
    app!.renderer.simulateKeystrokes("a")
    expect(pressed).toBeGreaterThan(0)
  })

  it("is seen by a MutationObserver as the carried write, through the attribute path of the mounted element", async () => {
    document.documentElement.setAttribute("class", "dark")
    mount()
    const records: string[] = []
    const observer = new MutationObserver((list) => list.forEach((record) => records.push(String(record.attributeName))))
    observer.observe(document.documentElement, { attributes: true })
    document.documentElement.setAttribute("class", "dark wide")
    await Promise.resolve()
    expect(document.documentElement.getAttribute("class")).toBe("dark wide")
    expect(records).toEqual(["class"])
    observer.disconnect()
  })

  it("leaves the stand-ins as nodes in no document", () => {
    const html = document.documentElement
    const head = document.head
    const body = document.body
    html.setAttribute("class", "dark")
    mount()
    expect(document.documentElement).not.toBe(html)
    for (const standIn of [html, head, body]) expect(standIn.isConnected).toBe(false)
    expect(html.parentNode).toBeNull()
    expect(html.nextSibling).toBeNull()
    expect(document.contains(html)).toBe(false)
    expect(document.contains(body)).toBe(false)
    expect(html.getRootNode()).toBe(html)
    expect([...document.childNodes]).toEqual([document.documentElement])
    // The tree among the stand-ins is intact and reads like a detached one.
    expect(body.parentNode).toBe(html)
    expect([...html.children]).toEqual([head, body])
    expect(html.contains(body)).toBe(true)
    expect(html.getAttribute("class")).toBe("dark")
    expect(() => body.appendChild(document.createElement("div"))).toThrow()
  })

  it("answers with fresh stand-ins once the last root unmounts, with nothing carried a second time", () => {
    const first = document.documentElement
    first.setAttribute("class", "dark")
    mount()
    const mounted = document.documentElement
    app!.unmount()
    app = undefined
    const second = document.documentElement
    expect(second).not.toBe(first)
    expect(second).not.toBe(mounted)
    expect(second.isConnected).toBe(true)
    expect(second.parentNode).toBe(document)
    expect(second.hasAttribute("class")).toBe(false)
    second.setAttribute("class", "light")
    mount()
    expect(document.documentElement.getAttribute("class")).toBe("light")
  })
})
