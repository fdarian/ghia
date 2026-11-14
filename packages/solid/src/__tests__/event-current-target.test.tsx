/**
 * A library clears `event.currentTarget` in a listener (`walkAtTop`-style loops). Every event Ghia
 * dispatches accepts the assignment, as the shadow accessors and data properties of its events allow;
 * a bare runtime `Event` nothing dispatched through Ghia has a getter-only `currentTarget`, as a
 * browser's has.
 */
import type { JSX } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const clear = (event: Event) => {
  ;(event as { currentTarget: unknown }).currentTarget = null
}

describe.skipIf(!hasNativeTestRenderer)("assigning event.currentTarget, in Solid", () => {
  let app: ReturnType<typeof createTestRoot> | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  function mount(tree: (grab: (name: string) => (instance: unknown) => void) => JSX.Element): Record<string, HTMLElement> {
    app = createTestRoot({ width: 400, height: 300 })
    const found: Record<string, HTMLElement> = {}
    const grab = (name: string) => (instance: unknown) => {
      if (instance !== null) found[name] = instance as HTMLElement
    }
    app.render(() => tree(grab))
    return found
  }

  const center = (element: HTMLElement) => {
    const bounds = app!.renderer.getElementBounds((element as unknown as { nativeId: number }).nativeId)
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2] as const
  }

  it("a native click: the element's own, document's and window's listeners may all assign it", () => {
    const errors: unknown[] = []
    const guard = (listener: (event: Event) => void) => (event: Event) => {
      try {
        listener(event)
      } catch (error) {
        errors.push(error)
      }
    }
    const found = mount((grab) => (
      <div ref={grab("el")} style={{ width: 100, height: 100 }} onClick={guard(clear)} onPointerDown={guard(clear)} />
    ))
    const onDocument = guard(clear)
    const onWindow = guard(clear)
    document.addEventListener("pointerdown", onDocument)
    document.addEventListener("click", onDocument, true)
    globalThis.addEventListener("pointerdown", onWindow)
    try {
      app!.renderer.nativeSimulateClick(...center(found.el))
    } finally {
      document.removeEventListener("pointerdown", onDocument)
      document.removeEventListener("click", onDocument, true)
      globalThis.removeEventListener("pointerdown", onWindow)
    }
    expect(errors).toEqual([])
  })

  it("an event an app dispatches at an element, a detached element and document", () => {
    const errors: unknown[] = []
    const guard = (event: Event) => {
      try {
        clear(event)
      } catch (error) {
        errors.push(error)
      }
    }
    const found = mount((grab) => <div ref={grab("el")} style={{ width: 100, height: 100 }} />)
    found.el.addEventListener("x", guard)
    document.addEventListener("x", guard)
    found.el.dispatchEvent(new Event("x", { bubbles: true }))
    const detached = document.createElement("div")
    detached.addEventListener("x", guard)
    detached.dispatchEvent(new Event("x"))
    document.dispatchEvent(new Event("x"))
    document.removeEventListener("x", guard)
    expect(errors).toEqual([])
  })

  it("a popover's toggle events, made by code and aimed at the element alone", () => {
    const errors: unknown[] = []
    const guard = (event: Event) => {
      try {
        clear(event)
      } catch (error) {
        errors.push(error)
      }
    }
    const found = mount((grab) => <div ref={grab("pop")} popover="manual" style={{ width: 100, height: 100 }} />)
    found.pop.addEventListener("beforetoggle", guard)
    found.pop.addEventListener("toggle", guard)
    found.pop.showPopover()
    found.pop.hidePopover()
    expect(errors).toEqual([])
  })
})
