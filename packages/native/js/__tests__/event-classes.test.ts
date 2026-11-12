import { describe, expect, it } from "vitest"
import type { EventPayload } from "../../index.js"
import {
  AnimationEvent,
  CompositionEvent,
  DragEvent,
  FocusEvent,
  InputEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  TransitionEvent,
  UIEvent,
  WheelEvent,
} from "../events/classes.js"
import { createDomEvent, dispatchDomEvent, type DomEvent } from "../events/dispatch.js"

describe("the DOM event classes", () => {
  it("are subclasses of the runtime's Event", () => {
    const pointer = new PointerEvent("pointerdown", { bubbles: true })
    expect(pointer).toBeInstanceOf(Event)
    expect(pointer).toBeInstanceOf(UIEvent)
    expect(pointer).toBeInstanceOf(MouseEvent)
    expect(pointer.type).toBe("pointerdown")
    expect(pointer.bubbles).toBe(true)
    expect(pointer.cancelable).toBe(false)
    expect(new KeyboardEvent("keydown")).toBeInstanceOf(UIEvent)
    expect(new TransitionEvent("transitionend")).not.toBeInstanceOf(UIEvent)
    expect(new TransitionEvent("transitionend")).toBeInstanceOf(Event)
  })

  it("give a MouseEvent and a PointerEvent the DOM's defaults", () => {
    const mouse = new MouseEvent("click")
    expect([mouse.clientX, mouse.clientY, mouse.screenX, mouse.screenY, mouse.button, mouse.buttons, mouse.detail]).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect([mouse.shiftKey, mouse.ctrlKey, mouse.altKey, mouse.metaKey]).toEqual([false, false, false, false])
    expect(mouse.relatedTarget).toBeNull()
    expect(mouse.view).toBeNull()
    const pointer = new PointerEvent("click")
    expect(pointer.pointerId).toBe(0)
    expect(pointer.pointerType).toBe("")
    expect(pointer.isPrimary).toBe(false)
    expect([pointer.width, pointer.height, pointer.pressure]).toEqual([1, 1, 0])
    expect(pointer.altitudeAngle).toBe(Math.PI / 2)
  })

  it("take every member of their init dictionary", () => {
    const target = {}
    const pointer = new PointerEvent("pointermove", {
      clientX: 3, clientY: 4, screenX: 5, screenY: 6, movementX: 1, movementY: -1, button: 2, buttons: 4, detail: 2,
      relatedTarget: target, shiftKey: true, pointerId: 7, pointerType: "pen", isPrimary: true, pressure: 0.5, cancelable: true,
    })
    expect([pointer.clientX, pointer.clientY, pointer.screenX, pointer.screenY, pointer.movementX, pointer.movementY]).toEqual([3, 4, 5, 6, 1, -1])
    expect([pointer.button, pointer.buttons, pointer.detail]).toEqual([2, 4, 2])
    expect(pointer.relatedTarget).toBe(target)
    expect([pointer.shiftKey, pointer.ctrlKey]).toEqual([true, false])
    expect([pointer.pointerId, pointer.pointerType, pointer.isPrimary, pointer.pressure]).toEqual([7, "pen", true, 0.5])
    expect(pointer.cancelable).toBe(true)
  })

  it("give the other classes their members and defaults", () => {
    const wheel = new WheelEvent("wheel", { deltaY: 12, deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect([wheel.deltaX, wheel.deltaY, wheel.deltaZ, wheel.deltaMode]).toEqual([0, 12, 0, 1])
    expect(wheel.DOM_DELTA_PAGE).toBe(2)
    expect(new DragEvent("drop").dataTransfer).toBeNull()
    const key = new KeyboardEvent("keydown", { key: "a", code: "KeyA", keyCode: 65, repeat: true, location: KeyboardEvent.DOM_KEY_LOCATION_LEFT })
    expect([key.key, key.code, key.keyCode, key.which, key.repeat, key.location, key.isComposing]).toEqual(["a", "KeyA", 65, 65, true, 1, false])
    expect(new KeyboardEvent("keyup").key).toBe("")
    const related = {}
    expect(new FocusEvent("focusin", { relatedTarget: related }).relatedTarget).toBe(related)
    expect(new FocusEvent("blur").relatedTarget).toBeNull()
    const input = new InputEvent("input", { data: "x", inputType: "insertText" })
    expect([input.data, input.inputType, input.isComposing]).toEqual(["x", "insertText", false])
    expect(new InputEvent("input").data).toBeNull()
    expect(new CompositionEvent("compositionend", { data: "é" }).data).toBe("é")
    expect(new CompositionEvent("compositionstart").data).toBe("")
    const transition = new TransitionEvent("transitionend", { propertyName: "opacity", elapsedTime: 0.3 })
    expect([transition.propertyName, transition.elapsedTime, transition.pseudoElement]).toEqual(["opacity", 0.3, ""])
    const animation = new AnimationEvent("animationend", { animationName: "spin", elapsedTime: 2 })
    expect([animation.animationName, animation.elapsedTime, animation.pseudoElement]).toEqual(["spin", 2, ""])
  })

  describe("getModifierState", () => {
    it("reads the four modifiers by their DOM key names", () => {
      const event = new KeyboardEvent("keydown", { shiftKey: true, metaKey: true })
      expect(event.getModifierState("Shift")).toBe(true)
      expect(event.getModifierState("Meta")).toBe(true)
      expect(event.getModifierState("Control")).toBe(false)
      expect(event.getModifierState("Alt")).toBe(false)
      const mouse = new MouseEvent("click", { ctrlKey: true, altKey: true })
      expect([mouse.getModifierState("Control"), mouse.getModifierState("Alt"), mouse.getModifierState("Shift")]).toEqual([true, true, false])
    })

    it("reads the modifiers an init gives that no platform reports, and is false for any other name", () => {
      const event = new KeyboardEvent("keydown", { modifierCapsLock: true, modifierAltGraph: true })
      expect(event.getModifierState("CapsLock")).toBe(true)
      expect(event.getModifierState("AltGraph")).toBe(true)
      expect(event.getModifierState("NumLock")).toBe(false)
      expect(event.getModifierState("Banana")).toBe(false)
      expect(new MouseEvent("click").getModifierState("CapsLock")).toBe(false)
    })
  })
})

describe("the events Ghia delivers", () => {
  const ids = [3, 2, 1]
  const elements = new Map<number, object>(ids.map((id) => [id, { id }]))
  const root = { eventHandlers: new Map(), elementById: (id: number) => elements.get(id) }

  function deliver(eventType: string, fields: Partial<EventPayload> = {}): DomEvent {
    return createDomEvent(root, { elementId: 3, eventType, target: 3, path: ids, ...fields } as EventPayload, ids.map((id) => elements.get(id)!), null).event
  }

  it.each([
    ["click", PointerEvent],
    ["auxclick", PointerEvent],
    ["contextmenu", PointerEvent],
    ["pointerdown", PointerEvent],
    ["pointermove", PointerEvent],
    ["gotpointercapture", PointerEvent],
    ["mousedown", MouseEvent],
    ["mouseup", MouseEvent],
    ["mousemove", MouseEvent],
    ["mouseenter", MouseEvent],
    ["dblclick", MouseEvent],
    ["wheel", WheelEvent],
    ["dragstart", DragEvent],
    ["drop", DragEvent],
    ["keydown", KeyboardEvent],
    ["keyup", KeyboardEvent],
    ["focus", FocusEvent],
    ["focusin", FocusEvent],
    ["blur", FocusEvent],
    ["input", InputEvent],
    ["compositionupdate", CompositionEvent],
    ["transitionend", TransitionEvent],
    ["animationstart", AnimationEvent],
  ] as const)("is a %s event an instance of its DOM class and of Event", (type, cls) => {
    const event = deliver(type)
    expect(event).toBeInstanceOf(cls)
    expect(event).toBeInstanceOf(Event)
    expect(event.constructor).toBe(cls)
    expect(event.type).toBe(type)
    expect(event.isTrusted).toBe(true)
  })

  it("is a plain Event for a type with no class of its own", () => {
    const event = deliver("scroll")
    expect(event).toBeInstanceOf(Event)
    expect(event).not.toBeInstanceOf(UIEvent)
    expect(event.bubbles).toBe(false)
  })

  it("is a plain Event for change, as in the DOM, and an InputEvent for input", () => {
    const change = deliver("change", { value: "x" })
    expect(change).not.toBeInstanceOf(UIEvent)
    expect([change.bubbles, change.cancelable]).toEqual([true, false])
    const input = deliver("input", { value: "x", inputType: "insertText", data: "x" })
    expect(input).toBeInstanceOf(InputEvent)
    expect([input.bubbles, input.cancelable]).toEqual([true, false])
    expect(deliver("input").data).toBeNull()
  })

  it("keeps every field of the payload and replaces the ids with elements", () => {
    const event = deliver("pointermove", { clientX: 10, clientY: 20, offsetX: 1, offsetY: 2, movementX: 3, movementY: 4, buttons: 1, pointerId: 1, pointerType: "mouse", relatedTarget: 2 })
    expect(event).toMatchObject({ clientX: 10, clientY: 20, offsetX: 1, offsetY: 2, movementX: 3, movementY: 4, buttons: 1, pointerId: 1, pointerType: "mouse", elementId: 3 })
    expect(event.target).toBe(elements.get(3))
    expect(event.srcElement).toBe(elements.get(3))
    expect(event.relatedTarget).toBe(elements.get(2))
    expect(event.composedPath()).toEqual([elements.get(3), elements.get(2), elements.get(1)])
    expect(event.nativeEvent).toBe(event)
    expect(Object.keys(event)).not.toContain("path")
    expect((event as unknown as Record<string, unknown>).submitterId).toBeUndefined()
  })

  it("has the modifiers of a mouse event's `modifiers` and a key event's booleans, as the DOM's four fields", () => {
    const mouse = deliver("pointerdown", { modifiers: { shift: true, ctrl: false, alt: false, cmd: true } })
    expect([mouse.shiftKey, mouse.ctrlKey, mouse.altKey, mouse.metaKey]).toEqual([true, false, false, true])
    expect(mouse.getModifierState("Shift")).toBe(true)
    expect(mouse.getModifierState("Meta")).toBe(true)
    expect(mouse.getModifierState("Control")).toBe(false)
    const key = deliver("keydown", { key: "Tab", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false })
    expect(key.getModifierState("Shift")).toBe(true)
    expect(key.getModifierState("CapsLock")).toBe(false)
    expect(deliver("click").shiftKey).toBe(false)
  })

  it("has the DOM's defaults for what native does not send", () => {
    const event = deliver("pointermove") as DomEvent & Record<string, unknown>
    expect([event.width, event.height, event.screenX, event.detail, event.view]).toEqual([1, 1, 0, 0, globalThis])
    expect(deliver("wheel").deltaZ).toBe(0)
    expect(deliver("keydown").location).toBe(0)
  })

  it("says whether a pointer event is the primary one, and leaves a mouse event without it", () => {
    expect(deliver("pointerdown", { pointerId: 1 }).isPrimary).toBe(true)
    expect(deliver("click", { pointerId: 1 }).isPrimary).toBe(true)
    expect(deliver("click", { pointerId: -1 }).isPrimary).toBe(false)
    expect(deliver("pointermove", { pointerId: -1 }).isPrimary).toBe(true)
    expect("isPrimary" in deliver("mousedown")).toBe(false)
  })

  it("bubbles and cancels as its type does", () => {
    expect(deliver("click")).toMatchObject({ bubbles: true, cancelable: true })
    expect(deliver("focus")).toMatchObject({ bubbles: false, cancelable: false })
    expect(deliver("focusin")).toMatchObject({ bubbles: true, cancelable: false })
  })

  it("has its own flags for default prevention and propagation, and the legacy members that read them", () => {
    const event = deliver("click")
    expect([event.defaultPrevented, event.returnValue, event.cancelBubble]).toEqual([false, true, false])
    event.preventDefault()
    event.stopPropagation()
    expect([event.defaultPrevented, event.returnValue, event.cancelBubble]).toEqual([true, false, true])
    const other = deliver("click")
    other.returnValue = false
    other.cancelBubble = true
    expect([other.defaultPrevented, other.cancelBubble]).toEqual([true, true])
    const plain = deliver("focusin")
    plain.preventDefault()
    expect(plain.defaultPrevented).toBe(false)
  })

  it("is not a runtime Event inside: its inherited native methods throw", () => {
    const event = deliver("click") as DomEvent & { initEvent(type: string): void }
    expect(() => event.initEvent("click")).toThrow()
  })

  it("has no target left to call after the dispatch, and keeps its target", () => {
    const seen: Array<[object | null, number]> = []
    const handlers = new Map([[3, new Map([["click", (event: DomEvent) => seen.push([event.currentTarget, event.eventPhase])]])]])
    const result = createRoot(handlers)
    const event = deliverThrough(result, "click")
    expect(seen).toEqual([[elements.get(3), 2]])
    expect(event.currentTarget).toBeNull()
    expect(event.eventPhase).toBe(0)
    expect(event.target).toBe(elements.get(3))
  })

  function createRoot(handlers: Map<number, Map<string, (event: DomEvent) => void>>) {
    return { eventHandlers: handlers as never, elementById: (id: number) => elements.get(id) }
  }

  function deliverThrough(rootWithHandlers: ReturnType<typeof createRoot>, eventType: string): DomEvent {
    let seen: DomEvent | undefined
    const handlers = rootWithHandlers.eventHandlers as unknown as Map<number, Map<string, (event: DomEvent) => void>>
    const target = handlers.get(3)!
    const original = target.get(eventType)!
    target.set(eventType, (event) => {
      seen = event
      original(event)
    })
    dispatchDomEvent(rootWithHandlers, { elementId: 3, eventType, target: 3, path: ids } as EventPayload)
    if (seen === undefined) throw new Error("the handler did not run")
    return seen
  }
})
