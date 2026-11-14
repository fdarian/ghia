import { describe, expect, it } from "vitest"
import { document, window } from "../events/window-target.js"
import "../dom-globals.js"

/** A library that clears `currentTarget` once it is done with it. */
function clearsCurrentTarget(event: Event): void {
  ;(event as { currentTarget: unknown }).currentTarget = null
}

describe("assigning event.currentTarget from a listener, as a browser's Event.currentTarget setter-less accessor would not allow", () => {
  it("is accepted on an event an app dispatches at document, which window hears too", () => {
    const seen: string[] = []
    const onWindow = (event: Event) => {
      seen.push(`window:${event.currentTarget === globalThis}`)
      clearsCurrentTarget(event)
    }
    const onDocument = (event: Event) => {
      seen.push(`document:${event.currentTarget === document}`)
      clearsCurrentTarget(event)
    }
    window.addEventListener("x", onWindow, true)
    document.addEventListener("x", onDocument)
    try {
      expect(() => document.dispatchEvent(new Event("x", { bubbles: true }))).not.toThrow()
    } finally {
      window.removeEventListener("x", onWindow, true)
      document.removeEventListener("x", onDocument)
    }
    expect(seen).toEqual(["window:true", "document:true"])
  })

  it("is read-only on an event nothing of Ghia's dispatched, as in a browser", () => {
    const event = new Event("x")
    expect(() => clearsCurrentTarget(event)).toThrow(TypeError)
  })
})
