import { afterEach, describe, expect, it } from "vitest"
import { ClipboardEvent, DragEvent } from "../events/classes.js"
import { lookupDeliveredType, defineDeliveredType } from "../events/delivered-events.js"
import { DataTransfer } from "../dom/data-transfer.js"
import { document, window } from "../events/window-target.js"
import { DOM_DISPATCHED_EVENT_TYPES } from "../events/event-props.js"
import { eventBubbles, eventIsCancelable, type DomEvent } from "../events/dispatch.js"
import { createDataTransfer } from "../events/data-transfer.js"
import "../dom-globals.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function listenOn(target: { addEventListener: Function; removeEventListener: Function }, type: string, listener: (event: DomEvent) => void) {
  target.addEventListener(type, listener)
  cleanups.push(() => target.removeEventListener(type, listener))
}

describe("ClipboardEvent", () => {
  it("is a global named ClipboardEvent, a subclass of the runtime's Event", () => {
    expect(Reflect.get(globalThis, "ClipboardEvent")).toBe(ClipboardEvent)
    const event = new ClipboardEvent("copy")
    expect(event.constructor.name).toBe("ClipboardEvent")
    expect(event).toBeInstanceOf(Event)
    expect(event.type).toBe("copy")
  })

  it("defaults to no clipboardData, and takes the init dictionary", () => {
    const plain = new ClipboardEvent("paste")
    expect(plain.clipboardData).toBeNull()
    expect([plain.bubbles, plain.cancelable, plain.composed]).toEqual([false, false, false])
    const data = new DataTransfer()
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true })
    expect(event.clipboardData).toBe(data)
    expect([event.bubbles, event.cancelable, event.composed]).toEqual([true, true, true])
    expect(new ClipboardEvent("cut", { clipboardData: null }).clipboardData).toBeNull()
  })

  it("is heard by a listener of the document and the window, and preventDefault cancels it", () => {
    const data = new DataTransfer()
    data.setData("text/plain", "x")
    const seen: string[] = []
    listenOn(window, "copy", (event) => seen.push(`window ${(event as unknown as ClipboardEvent).clipboardData?.getData("text")}`))
    listenOn(document, "copy", (event) => {
      seen.push("document")
      event.preventDefault()
    })
    const event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true })
    expect(document.dispatchEvent(event)).toBe(false)
    expect(seen).toEqual(["document", "window x"])
    expect(event.defaultPrevented).toBe(true)
  })
})

describe("copy, cut and paste", () => {
  it.each(["copy", "cut", "paste"])("%s is a delivered ClipboardEvent type that bubbles and can be cancelled", (type) => {
    expect(DOM_DISPATCHED_EVENT_TYPES.has(type)).toBe(true)
    expect(eventBubbles(type)).toBe(true)
    expect(eventIsCancelable(type)).toBe(true)
    const delivered = lookupDeliveredType(type) ?? defineDeliveredType(type, true, true)
    expect(delivered.prototype).toBeInstanceOf(ClipboardEvent)
    expect(Reflect.get(delivered.prototype, "clipboardData")).toBeNull()
  })
})

describe("DragEvent and drag data", () => {
  it("a drag's dataTransfer is an instance of the global DataTransfer", () => {
    const { dataTransfer } = createDataTransfer()
    expect(dataTransfer).toBeInstanceOf(DataTransfer)
    expect(dataTransfer.constructor.name).toBe("DataTransfer")
    expect(new DragEvent("drop", { dataTransfer }).dataTransfer).toBe(dataTransfer)
  })

  it("a drag of files lists them and Files, whatever the mode", () => {
    const file = { path: "/tmp/a.txt", name: "a.txt", size: 1, type: "text/plain", lastModified: 2 }
    const session = createDataTransfer([file])
    expect(session.mode).toBe("protected")
    expect(session.dataTransfer.types).toEqual(["Files"])
    expect(session.dataTransfer.files).toEqual([file])
    expect(session.dataTransfer.effectAllowed).toBe("all")
    expect(createDataTransfer().dataTransfer.effectAllowed).toBe("uninitialized")
  })
})
