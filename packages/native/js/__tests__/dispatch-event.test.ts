import { afterEach, describe, expect, it, vi } from "vitest"
import { DOM_BINDING, HTMLElement, type ElementBinding, type Node } from "../dom/nodes.js"
import { defineDomMembers } from "../dom-members.js"
import { ElementListeners } from "../events/element-listeners.js"
import { document, window } from "../events/window-target.js"
import { PointerEvent } from "../events/classes.js"
import type { DomEvent } from "../events/dispatch.js"
import "../dom-globals.js"

class Box extends HTMLElement {
  parent: Node | null = null
  connected = true
  readonly listeners = new ElementListeners()
  constructor(readonly name: string) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    return {
      parent: this.parent,
      children: [],
      connected: this.connected,
      root: null,
      type: "div",
      prop: () => undefined,
      propNames: () => [],
    }
  }
  /** The handler of an `on*` prop, which an adapter sets through `setProp`. */
  prop(key: string, handler: (event: DomEvent) => void): void {
    this.listeners.setProp(key, handler as never)
  }
}
defineDomMembers(Box.prototype, (box: Box) => ({
  listeners: box.listeners,
  connected: box.connected,
  layout: undefined,
  prop: () => undefined,
  propNames: () => [],
  writeProp: () => {},
  readStyle: () => undefined,
  writeStyle: () => {},
}))

/** `outer` contains `middle` contains `inner`. */
function tree(connected = true) {
  const outer = new Box("outer")
  const middle = new Box("middle")
  const inner = new Box("inner")
  middle.parent = outer
  inner.parent = middle
  for (const box of [outer, middle, inner]) box.connected = connected
  return { outer, middle, inner }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function listenOn(target: { addEventListener: Function; removeEventListener: Function }, type: string, listener: (event: DomEvent) => void, capture = false) {
  target.addEventListener(type, listener, capture)
  cleanups.push(() => target.removeEventListener(type, listener, capture))
}

describe("dispatchEvent of an element", () => {
  it("walks capture, target and bubble for any runtime event, and tells where each listener is", () => {
    const { outer, middle, inner } = tree()
    const calls: string[] = []
    const log = (label: string) => (event: DomEvent) => {
      calls.push(`${label} ${event.eventPhase} ${event.currentTarget === outer ? "outer" : event.currentTarget === middle ? "middle" : event.currentTarget === inner ? "inner" : "other"}`)
    }
    outer.prop("xCapture", log("outer prop capture"))
    outer.addEventListener("x", log("outer capture") as never, true)
    middle.prop("x", log("middle prop"))
    inner.addEventListener("x", log("inner") as never)
    inner.addEventListener("x", log("inner capture") as never, { capture: true })
    outer.addEventListener("x", log("outer") as never)
    listenOn(window, "x", log("window capture"), true)
    listenOn(document, "x", log("document capture"), true)
    listenOn(document, "x", log("document"))
    listenOn(window, "x", log("window"))
    const event = new CustomEvent("x", { bubbles: true, detail: { n: 1 } })
    expect(inner.dispatchEvent(event)).toBe(true)
    expect(calls).toEqual([
      "window capture 1 other",
      "document capture 1 other",
      "outer prop capture 1 outer",
      "outer capture 1 outer",
      "inner capture 2 inner",
      "inner 2 inner",
      "middle prop 3 middle",
      "outer 3 outer",
      "document 3 other",
      "window 3 other",
    ])
  })

  it("keeps the event's own members, and the DOM ones around the dispatch", () => {
    const { outer, middle, inner } = tree()
    const event = new CustomEvent("x", { bubbles: true, detail: { n: 1 } })
    expect([event.target, event.currentTarget, event.eventPhase]).toEqual([null, null, 0])
    let inside: unknown[] = []
    outer.addEventListener("x", ((seen: CustomEvent) => {
      inside = [seen === event, seen.detail, seen.target, seen.srcElement, seen.currentTarget, seen.eventPhase, seen.composedPath(), seen.isTrusted]
    }) as never)
    inner.dispatchEvent(event)
    expect(inside).toEqual([true, { n: 1 }, inner, inner, outer, 3, [inner, middle, outer], false])
    expect([event.target, event.currentTarget, event.eventPhase, event.composedPath()]).toEqual([inner, null, 0, []])
    expect(event.isTrusted).toBe(false)
  })

  it("runs a PointerEvent's constructor, with its fields, and the on* props of the path", () => {
    const { outer, inner } = tree()
    let seen: PointerEvent | undefined
    outer.prop("click", (event) => {
      seen = event as unknown as PointerEvent
    })
    const event = new PointerEvent("click", { bubbles: true, cancelable: true, shiftKey: true, pointerId: 3 })
    expect(inner.dispatchEvent(event)).toBe(true)
    expect(seen).toBe(event)
    expect(seen?.getModifierState("Shift")).toBe(true)
    expect(seen?.pointerId).toBe(3)
  })

  it("does not bubble an event that does not bubble, but captures it and runs the target's listeners", () => {
    const { outer, middle, inner } = tree()
    const calls: string[] = []
    outer.addEventListener("x", (() => calls.push("outer capture")) as never, true)
    outer.addEventListener("x", (() => calls.push("outer")) as never)
    middle.addEventListener("x", (() => calls.push("middle")) as never)
    inner.addEventListener("x", (() => calls.push("inner")) as never)
    listenOn(document, "x", () => calls.push("document"))
    inner.dispatchEvent(new Event("x", { bubbles: false }))
    expect(calls).toEqual(["outer capture", "inner"])
  })

  it("stops the walk at stopPropagation, and the list at stopImmediatePropagation", () => {
    const { outer, middle, inner } = tree()
    const calls: string[] = []
    middle.addEventListener("x", ((event: Event) => {
      calls.push("middle 1")
      event.stopPropagation()
    }) as never)
    middle.addEventListener("x", (() => calls.push("middle 2")) as never)
    outer.addEventListener("x", (() => calls.push("outer")) as never)
    inner.dispatchEvent(new Event("x", { bubbles: true }))
    expect(calls).toEqual(["middle 1", "middle 2"])

    calls.length = 0
    const event = new Event("x", { bubbles: true })
    middle.removeEventListener("x", middle.listeners.get("x") as never)
    const stopping = (seen: Event) => {
      calls.push("first")
      seen.stopImmediatePropagation()
    }
    inner.addEventListener("x", stopping as never)
    inner.addEventListener("x", (() => calls.push("second")) as never)
    inner.dispatchEvent(event)
    expect(calls).toEqual(["first"])
    expect(event.cancelBubble).toBe(false)
  })

  it("stops the walk at cancelBubble = true", () => {
    const { outer, inner } = tree()
    const calls: string[] = []
    inner.addEventListener("x", ((event: Event) => {
      event.cancelBubble = true
    }) as never)
    outer.addEventListener("x", (() => calls.push("outer")) as never)
    inner.dispatchEvent(new Event("x", { bubbles: true }))
    expect(calls).toEqual([])
  })

  it("returns false for a canceled event that is cancelable and true for one that is not", () => {
    const { inner } = tree()
    inner.addEventListener("x", ((event: Event) => event.preventDefault()) as never)
    const cancelable = new Event("x", { cancelable: true })
    expect(inner.dispatchEvent(cancelable)).toBe(false)
    expect(cancelable.defaultPrevented).toBe(true)
    expect(cancelable.returnValue).toBe(false)
    const plain = new Event("x")
    expect(inner.dispatchEvent(plain)).toBe(true)
    expect(plain.defaultPrevented).toBe(false)
  })

  it("ignores preventDefault in a passive listener", () => {
    const { inner } = tree()
    inner.addEventListener("x", ((event: Event) => event.preventDefault()) as never, { passive: true })
    expect(inner.dispatchEvent(new Event("x", { cancelable: true }))).toBe(true)
  })

  it("throws an InvalidStateError for an event that is being dispatched, and allows it once it is over", () => {
    const { inner, middle } = tree()
    let thrown: unknown
    inner.addEventListener("x", ((event: Event) => {
      try {
        middle.dispatchEvent(event)
      } catch (error) {
        thrown = error
      }
    }) as never)
    const event = new Event("x")
    inner.dispatchEvent(event)
    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe("InvalidStateError")
    const again: string[] = []
    middle.addEventListener("x", (() => again.push("middle")) as never)
    middle.dispatchEvent(event)
    expect(again).toEqual(["middle"])
  })

  it("throws a TypeError for something that is not an event", () => {
    const { inner } = tree()
    expect(() => inner.dispatchEvent({ type: "x" } as unknown as Event)).toThrow(TypeError)
  })

  it("is heard by the listeners of the path alone, not by window or document, when the element is not connected", () => {
    const { outer, inner } = tree(false)
    const calls: string[] = []
    outer.addEventListener("x", (() => calls.push("outer")) as never)
    listenOn(document, "x", () => calls.push("document"))
    listenOn(window, "x", () => calls.push("window"))
    inner.dispatchEvent(new Event("x", { bubbles: true }))
    expect(calls).toEqual(["outer"])
  })

  it("reports the error of a listener and runs the others, as a delivered event does", () => {
    const { inner } = tree()
    const report = vi.fn()
    vi.stubGlobal("reportError", report)
    cleanups.push(() => vi.unstubAllGlobals())
    const calls: string[] = []
    inner.addEventListener("x", (() => {
      throw new Error("boom")
    }) as never)
    inner.addEventListener("x", (() => calls.push("second")) as never)
    expect(() => inner.dispatchEvent(new Event("x"))).not.toThrow()
    expect(calls).toEqual(["second"])
    expect(report).toHaveBeenCalledOnce()
  })
})

describe("dispatchEvent of document", () => {
  it("gives window its capture phase, document its target phase and window its bubble phase", () => {
    const calls: string[] = []
    listenOn(window, "x", (event) => calls.push(`window capture ${event.eventPhase}`), true)
    listenOn(document, "x", (event) => calls.push(`document capture ${event.eventPhase}`), true)
    listenOn(document, "x", (event) => calls.push(`document ${event.eventPhase} ${event.target === document}`))
    listenOn(window, "x", (event) => calls.push(`window ${event.eventPhase}`))
    const event = new Event("x", { bubbles: true, cancelable: true })
    expect(document.dispatchEvent(event)).toBe(true)
    expect(calls).toEqual(["window capture 1", "document capture 2", "document 2 true", "window 3"])
    expect([event.target, event.currentTarget, event.eventPhase]).toEqual([document, null, 0])
  })

  it("keeps a non-bubbling event from window's bubble phase, and returns false when canceled", () => {
    const calls: string[] = []
    listenOn(document, "x", (event) => {
      calls.push("document")
      event.preventDefault()
    })
    listenOn(window, "x", () => calls.push("window"))
    expect(document.dispatchEvent(new Event("x", { cancelable: true }))).toBe(false)
    expect(calls).toEqual(["document"])
  })
})
