/** `dispatchEvent` on an element and on `document`: what an app's event reaches, in Solid. */
import { afterEach, describe, expect, it } from "vitest"
import { document, window, type DomEvent } from "@ghia/native/host"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("dispatchEvent in Solid", () => {
  let app: ReturnType<typeof createTestRoot>
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    app.unmount()
  })

  function listen(target: { addEventListener: Function; removeEventListener: Function }, type: string, listener: (event: DomEvent) => void, capture = false) {
    target.addEventListener(type, listener, capture)
    cleanups.push(() => target.removeEventListener(type, listener, capture))
  }

  type Handlers = Record<string, (event: DomEvent) => void>

  /** `<div outer><div middle><div inner/></div></div>`, each with the handlers given as `on*` props. */
  function mount(handlers: { outer?: Handlers; middle?: Handlers; inner?: Handlers } = {}) {
    app = createTestRoot()
    let outer!: HostElement
    let middle!: HostElement
    let inner!: HostElement
    app.render(() => (
      <div ref={outer} testId="outer" style={{ width: 200, height: 100 }} {...handlers.outer}>
        <div ref={middle} testId="middle" style={{ width: 150, height: 80 }} {...handlers.middle}>
          <div ref={inner} testId="inner" tabIndex={0} style={{ width: 100, height: 60 }} {...handlers.inner} />
        </div>
      </div>
    ))
    return { outer, middle, inner }
  }

  it("runs a PointerEvent through capture, target and bubble, with props, listeners, document and window", () => {
    const calls: string[] = []
    const note = (label: string) => (event: DomEvent) => calls.push(`${label} ${event.eventPhase}`)
    const nodes = mount({
      outer: { onClickCapture: note("outer capture prop"), onClick: note("outer prop") },
      middle: { onClick: note("middle prop") },
      inner: { onClick: note("inner prop"), onClickCapture: note("inner capture prop") },
    })
    nodes.middle.addEventListener("click", note("middle listener") as never)
    nodes.middle.addEventListener("click", note("middle capture listener") as never, true)
    listen(window, "click", note("window capture"), true)
    listen(document, "click", note("document"))
    listen(window, "click", note("window"))
    const Pointer = nodes.inner.ownerDocument.defaultView!.PointerEvent
    const event = new Pointer("click", { bubbles: true, cancelable: true, shiftKey: true })
    expect(nodes.inner.dispatchEvent(event)).toBe(true)
    expect(calls).toEqual([
      "window capture 1",
      "outer capture prop 1",
      "middle capture listener 1",
      "inner capture prop 2",
      "inner prop 2",
      "middle prop 3",
      "middle listener 3",
      "outer prop 3",
      "document 3",
      "window 3",
    ])
    expect(event.isTrusted).toBe(false)
    expect(event.getModifierState("Shift")).toBe(true)
  })

  it("sends a CustomEvent with its detail to listeners of the path, and a non-bubbling Event to the target and capturers", () => {
    const nodes = mount()
    const seen: unknown[] = []
    nodes.outer.addEventListener("x", ((event: CustomEvent) => seen.push(["outer", event.detail])) as never)
    nodes.inner.addEventListener("x", ((event: CustomEvent) => seen.push(["inner", event.detail, event.target === nodes.inner])) as never)
    nodes.inner.dispatchEvent(new CustomEvent("x", { bubbles: true, detail: 42 }))
    expect(seen).toEqual([["inner", 42, true], ["outer", 42]])

    const flat: string[] = []
    nodes.outer.addEventListener("y", (() => flat.push("outer capture")) as never, true)
    nodes.outer.addEventListener("y", (() => flat.push("outer")) as never)
    nodes.inner.addEventListener("y", (() => flat.push("inner")) as never)
    nodes.inner.dispatchEvent(new Event("y", { bubbles: false }))
    expect(flat).toEqual(["outer capture", "inner"])
  })

  it("honors stopPropagation, stopImmediatePropagation and preventDefault from a Solid handler", () => {
    const calls: string[] = []
    const nodes = mount({
      outer: { onClick: () => calls.push("outer") },
      middle: {
        onClick: (event) => {
          calls.push("middle")
          event.stopPropagation()
        },
      },
      inner: {
        onClick: (event) => {
          calls.push("inner")
          event.preventDefault()
        },
      },
    })
    const event = new globalThis.PointerEvent("click", { bubbles: true, cancelable: true })
    expect(nodes.inner.dispatchEvent(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(calls).toEqual(["inner", "middle"])

    calls.length = 0
    nodes.inner.addEventListener("z", ((seen: Event) => {
      calls.push("first")
      seen.stopImmediatePropagation()
    }) as never)
    nodes.inner.addEventListener("z", (() => calls.push("second")) as never)
    nodes.outer.addEventListener("z", (() => calls.push("outer")) as never)
    expect(nodes.inner.dispatchEvent(new Event("z", { bubbles: true }))).toBe(true)
    expect(calls).toEqual(["first"])
  })

  it("is heard by onFocus as the focus it is keyed under, and does not move focus", () => {
    const calls: string[] = []
    const nodes = mount({
      outer: { onFocus: (event) => calls.push(`outer focus ${event.type}`), onFocusIn: (event) => calls.push(`outer focusin ${event.type}`) },
      inner: { onFocus: (event) => calls.push(`inner focus ${event.type}`) },
    })
    nodes.inner.dispatchEvent(new globalThis.FocusEvent("focus"))
    nodes.inner.dispatchEvent(new globalThis.FocusEvent("focusin", { bubbles: true }))
    expect(calls).toEqual(["inner focus focus", "outer focusin focusin"])
    expect(app.renderer.getFocusedElementId()).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it("throws an InvalidStateError for an event dispatched from inside its own dispatch", () => {
    const nodes = mount()
    let thrown: unknown
    nodes.inner.addEventListener("x", ((event: Event) => {
      try {
        nodes.middle.dispatchEvent(event)
      } catch (error) {
        thrown = error
      }
    }) as never)
    nodes.inner.dispatchEvent(new Event("x"))
    expect((thrown as DOMException).name).toBe("InvalidStateError")
  })

  it("dispatches at document, which window hears in both phases a bubbling event has", () => {
    mount()
    const calls: string[] = []
    listen(window, "x", (event) => calls.push(`window ${event.eventPhase}`), true)
    listen(document, "x", (event) => calls.push(`document ${event.eventPhase}`))
    listen(window, "x", (event) => calls.push(`window ${event.eventPhase}`))
    document.dispatchEvent(new Event("x", { bubbles: true }))
    expect(calls).toEqual(["window 1", "document 2", "window 3"])
  })

  it("hears a real click as trusted and a dispatched one as not", () => {
    const nodes = mount()
    const trusted: boolean[] = []
    nodes.inner.addEventListener("click", ((event: Event) => trusted.push(event.isTrusted)) as never)
    const bounds = app.renderer.getElementBounds(app.renderer.findByTestId("inner")!.id)!
    app.renderer.nativeSimulateClick(bounds.x + 5, bounds.y + 5)
    nodes.inner.dispatchEvent(new globalThis.PointerEvent("click"))
    expect(trusted).toEqual([true, false])
  })
})
