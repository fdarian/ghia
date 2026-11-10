import { describe, expect, it } from "vitest"
import { createDomEvent } from "../events/dispatch.js"

describe("event fields for a library that wraps events", () => {
  const noRoot = { eventHandlers: new Map(), elementById: () => undefined }

  function eventOf(eventType: string) {
    return createDomEvent(noRoot, { elementId: 0, eventType }, [], null).event
  }

  it("has nativeEvent, the event itself", () => {
    const event = eventOf("click")
    expect(event.nativeEvent).toBe(event)
  })

  it("has isPrimary on pointer events and the clicks Chrome makes PointerEvents", () => {
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerenter", "gotpointercapture", "click", "auxclick", "contextmenu"]) {
      expect(eventOf(type).isPrimary).toBe(true)
    }
    for (const type of ["pointerDown", "pointerMove"]) expect(eventOf(type).isPrimary).toBe(true)
    for (const type of ["dblclick", "keydown", "mousedown", "pointerlockchange", "focus"]) {
      expect(eventOf(type)).not.toHaveProperty("isPrimary")
    }
  })
})
