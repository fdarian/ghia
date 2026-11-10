import { describe, expect, it, vi } from "vitest"
import type { EventPayload } from "../../index.js"
import type { EventHandlerMap } from "../host.js"
import { dispatchDomEvent, type DomEvent } from "../events/dispatch.js"
import { ElementListeners } from "../events/element-listeners.js"

const PARENT = 1
const CHILD = 2
const elements = new Map<number, object>([PARENT, CHILD].map((id) => [id, { id }]))

function setup() {
  const eventHandlers: EventHandlerMap = new Map()
  const native: Array<[number, string, boolean]> = []
  const make = (id: number) => {
    const listeners = new ElementListeners()
    listeners.attach({
      eventHandlers,
      elementId: id,
      renderer: {
        setEventListener: (element, type, on) => native.push([element, type, on]),
        flushMutations() {},
      },
    })
    return listeners
  }
  const dispatch = (type: string, path = [CHILD, PARENT]) => {
    const payload = { elementId: path[0], eventType: type, path } as EventPayload
    return dispatchDomEvent({ eventHandlers, elementById: (id) => elements.get(id) }, payload)
  }
  return { eventHandlers, native, make, dispatch }
}

describe("ElementListeners", () => {
  it("keeps a lone prop as the handler itself", () => {
    const { eventHandlers, make } = setup()
    const listeners = make(CHILD)
    const handler = () => {}
    listeners.setProp("click", handler)
    expect(eventHandlers.get(CHILD)?.get("click")).toBe(handler)
  })

  it("orders a prop among listeners where it was first set, and replaces it in place", () => {
    const { make, dispatch } = setup()
    const calls: string[] = []
    const listeners = make(CHILD)
    listeners.addEventListener("click", () => calls.push("first"))
    listeners.setProp("click", () => calls.push("prop"))
    listeners.addEventListener("click", () => calls.push("last"))
    dispatch("click")
    listeners.setProp("click", () => calls.push("prop 2"))
    dispatch("click")
    expect(calls).toEqual(["first", "prop", "last", "first", "prop 2", "last"])
  })

  it("puts a prop that was added before listeners first, and one set again after an unset last", () => {
    const { make, dispatch } = setup()
    const calls: string[] = []
    const listeners = make(CHILD)
    const prop = () => calls.push("prop")
    listeners.setProp("click", prop)
    listeners.addEventListener("click", () => calls.push("listener"))
    dispatch("click")
    listeners.setProp("click", undefined)
    listeners.setProp("click", prop)
    dispatch("click")
    expect(calls).toEqual(["prop", "listener", "listener", "prop"])
  })

  it("tells native once per type while an entry exists in either phase", () => {
    const { make, native } = setup()
    const listeners = make(CHILD)
    const a = () => {}
    const b = () => {}
    listeners.addEventListener("scroll", a)
    listeners.addEventListener("scroll", b)
    listeners.addEventListener("scroll", b, true)
    expect(native).toEqual([[CHILD, "scroll", true]])
    listeners.removeEventListener("scroll", a)
    listeners.removeEventListener("scroll", b)
    expect(native).toEqual([[CHILD, "scroll", true]])
    listeners.removeEventListener("scroll", b, { capture: true })
    expect(native).toEqual([
      [CHILD, "scroll", true],
      [CHILD, "scroll", false],
    ])
  })

  it("accepts a type native never emits, and never calls it", () => {
    const { make, dispatch } = setup()
    const listener = vi.fn()
    make(CHILD).addEventListener("touchstart", listener, { capture: true, passive: true })
    dispatch("click")
    expect(listener).not.toHaveBeenCalled()
  })

  it("ignores the same listener and phase twice, and keeps the two phases apart", () => {
    const { make, dispatch } = setup()
    const calls: string[] = []
    const listener = (event: DomEvent) => calls.push(`${event.eventPhase}`)
    const listeners = make(CHILD)
    listeners.addEventListener("click", listener)
    listeners.addEventListener("click", listener)
    listeners.addEventListener("click", listener, true)
    dispatch("click")
    expect(calls).toEqual(["2", "2"])
  })

  it("runs the capture listeners of an ancestor before the target's", () => {
    const { make, dispatch } = setup()
    const calls: string[] = []
    const parent = make(PARENT)
    parent.addEventListener("click", () => calls.push("parent bubble"))
    parent.addEventListener("click", () => calls.push("parent capture"), { capture: true })
    make(CHILD).addEventListener("click", () => calls.push("child"))
    dispatch("click")
    expect(calls).toEqual(["parent capture", "child", "parent bubble"])
  })

  it("removes a once listener before it runs", () => {
    const { make, dispatch, native } = setup()
    const calls: string[] = []
    const listeners = make(CHILD)
    listeners.addEventListener("click", () => calls.push("once"), { once: true })
    dispatch("click")
    dispatch("click")
    expect(calls).toEqual(["once"])
    expect(native.at(-1)).toEqual([CHILD, "click", false])
  })

  it("removes a listener when its signal aborts, and adds none for one that has", () => {
    const { make, dispatch } = setup()
    const calls: string[] = []
    const listeners = make(CHILD)
    const controller = new AbortController()
    listeners.addEventListener("click", () => calls.push("signal"), { signal: controller.signal })
    dispatch("click")
    controller.abort()
    dispatch("click")
    listeners.addEventListener("click", () => calls.push("late"), { signal: controller.signal })
    dispatch("click")
    expect(calls).toEqual(["signal"])
  })

  it("makes preventDefault do nothing in a passive listener only", () => {
    const { make, dispatch } = setup()
    const listeners = make(CHILD)
    const seen: boolean[] = []
    listeners.addEventListener("click", (event) => {
      event.preventDefault()
      seen.push(event.defaultPrevented)
    }, { passive: true })
    expect(dispatch("click").defaultPrevented).toBe(false)
    listeners.addEventListener("keydown", (event) => event.preventDefault())
    expect(dispatch("keydown").defaultPrevented).toBe(true)
    expect(seen).toEqual([false])
  })

  it("stops the rest of the list at stopImmediatePropagation, and runs the rest after a throw", () => {
    const { make, dispatch } = setup()
    const calls: string[] = []
    const reportError = vi.fn()
    const listeners = make(CHILD)
    listeners.addEventListener("click", () => {
      throw new Error("first")
    })
    listeners.addEventListener("click", (event) => {
      calls.push("second")
      event.stopImmediatePropagation()
    })
    listeners.addEventListener("click", () => calls.push("third"))
    vi.stubGlobal("reportError", reportError)
    try {
      dispatch("click")
    } finally {
      vi.unstubAllGlobals()
    }
    expect(calls).toEqual(["second"])
    expect(reportError).toHaveBeenCalledTimes(1)
  })

  it("does not call a listener removed during the dispatch, nor one added during it", () => {
    const { make, dispatch } = setup()
    const calls: string[] = []
    const listeners = make(CHILD)
    const removed = () => calls.push("removed")
    listeners.addEventListener("click", () => {
      calls.push("first")
      listeners.removeEventListener("click", removed)
      listeners.addEventListener("click", () => calls.push("added"))
    })
    listeners.addEventListener("click", removed)
    dispatch("click")
    expect(calls).toEqual(["first"])
    dispatch("click")
    expect(calls).toEqual(["first", "first", "added"])
  })

  it("calls a listener object's handleEvent, and a function with the element as this", () => {
    const { make, dispatch } = setup()
    const seen: unknown[] = []
    const listeners = make(CHILD)
    listeners.addEventListener("click", { handleEvent: (event) => seen.push(event.type) })
    listeners.addEventListener("click", function (this: unknown) {
      seen.push(this)
    })
    dispatch("click")
    expect(seen).toEqual(["click", elements.get(CHILD)])
  })

  it("registers on attach what was added before the element existed, and nothing after detach", () => {
    const { eventHandlers, native, dispatch } = setup()
    const listeners = new ElementListeners()
    const calls: string[] = []
    listeners.setProp("click", () => calls.push("prop"))
    listeners.addEventListener("click", () => calls.push("listener"))
    expect(eventHandlers.size).toBe(0)
    listeners.attach({
      eventHandlers,
      elementId: CHILD,
      renderer: {
        setEventListener: (element, type, on) => native.push([element, type, on]),
        flushMutations() {},
      },
    })
    dispatch("click")
    expect(calls).toEqual(["prop", "listener"])
    listeners.detach()
    eventHandlers.clear()
    listeners.addEventListener("click", () => calls.push("after"))
    expect(eventHandlers.size).toBe(0)
  })
})
