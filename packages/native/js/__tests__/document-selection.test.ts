import { afterEach, describe, expect, it } from "vitest"
import type { EventPayload } from "../../index.js"
import "../dom-globals.js"
import { document, syncWindowSelectionChange, window as ghiaWindow } from "../events/window-target.js"
import { createRendererState } from "../renderer-state.js"
import type { NativeRenderer } from "../host.js"

class FakeWindow {
  selected: string | null = null
  clears = 0
  selectionChangeCalls: Array<[boolean, number]> = []

  applyBatch(): number[] {
    return []
  }

  getSelectedText(): string | null {
    return this.selected
  }

  clearSelection(): void {
    this.clears++
    this.selected = null
  }

  setWindowSelectionChange(enabled: boolean, eventId: number): void {
    this.selectionChangeCalls.push([enabled, eventId])
  }
}

describe("getSelection", () => {
  const mounted: Array<{ detach(): boolean }> = []
  afterEach(() => {
    for (const binding of mounted.splice(0)) binding.detach()
  })

  function mountWindow(): { fake: FakeWindow; eventId: number; state: ReturnType<typeof createRendererState> } {
    const fake = new FakeWindow()
    const state = createRendererState(fake as unknown as NativeRenderer)
    const binding = state.attach({ onSelectionChange: undefined })
    mounted.push(binding)
    return { fake, eventId: binding.windowSelectionEventId, state }
  }

  it("is one Selection that nothing can construct, on document and window", () => {
    expect(document.getSelection()).toBe(window.getSelection())
    expect(document.getSelection()).toBeInstanceOf(Selection)
    expect(() => new (Selection as unknown as new () => object)()).toThrow("Illegal constructor")
    expect(Object.prototype.toString.call(document.getSelection())).toBe("[object Selection]")
  })

  it("has no ranges and no text while nothing is selected", () => {
    mountWindow()
    const selection = document.getSelection()
    expect(selection.rangeCount).toBe(0)
    expect(selection.isCollapsed).toBe(true)
    expect(selection.type).toBe("None")
    expect(selection.toString()).toBe("")
  })

  it("reads the selected text of the window", () => {
    const { fake } = mountWindow()
    fake.selected = "hello\nworld"
    const selection = window.getSelection()!
    expect(selection.rangeCount).toBe(1)
    expect(selection.isCollapsed).toBe(false)
    expect(selection.type).toBe("Range")
    expect(selection.toString()).toBe("hello\nworld")
    expect(`${selection}`).toBe("hello\nworld")
  })

  it("clears with removeAllRanges and empty", () => {
    const { fake } = mountWindow()
    fake.selected = "a"
    document.getSelection().removeAllRanges()
    expect(fake.clears).toBe(1)
    expect(document.getSelection().rangeCount).toBe(0)
    fake.selected = "b"
    document.getSelection().empty()
    expect(fake.clears).toBe(2)
  })

  it("has only the members it can answer", () => {
    const selection = document.getSelection() as unknown as Record<string, unknown>
    for (const name of ["getRangeAt", "addRange", "anchorNode", "collapse", "selectAllChildren"]) {
      expect(name in selection).toBe(false)
    }
  })

  it("throws before a root is mounted", () => {
    expect(() => document.getSelection().rangeCount).toThrow(/mounted/)
    expect(() => document.getSelection().removeAllRanges()).toThrow(/mounted/)
  })

  describe("selectionchange on document", () => {
    function selectionChange(eventId: number, value?: string): EventPayload {
      return { elementId: eventId, eventType: "selectionChange", ...(value === undefined ? {} : { value }) }
    }

    it("is sent when native reports a selection change, to document capture and bubble listeners and window capture", () => {
      const { eventId, state } = mountWindow()
      const seen: string[] = []
      const onDocument = (event: { target: unknown; currentTarget: unknown; eventPhase: number }) =>
        seen.push(`document:${event.target === document}:${event.currentTarget === document}:${event.eventPhase}`)
      const onDocumentCapture = () => seen.push("document capture")
      const onWindowCapture = () => seen.push("window capture")
      const onWindowBubble = () => seen.push("window bubble")
      document.addEventListener("selectionchange", onDocument)
      document.addEventListener("selectionchange", onDocumentCapture, { capture: true })
      ghiaWindow.addEventListener("selectionchange", onWindowCapture, { capture: true })
      ghiaWindow.addEventListener("selectionchange", onWindowBubble)
      try {
        expect(state.dispatch(selectionChange(eventId, "text"))).toBe(true)
      } finally {
        document.removeEventListener("selectionchange", onDocument)
        document.removeEventListener("selectionchange", onDocumentCapture, { capture: true })
        ghiaWindow.removeEventListener("selectionchange", onWindowCapture, { capture: true })
        ghiaWindow.removeEventListener("selectionchange", onWindowBubble)
      }
      expect(seen).toEqual(["window capture", "document capture", "document:true:true:2"])
    })

    it("is ignored when nobody listens, and for another root's event id", () => {
      const { eventId, state } = mountWindow()
      expect(state.dispatch(selectionChange(eventId))).toBe(false)
      const seen: string[] = []
      const listener = () => seen.push("selectionchange")
      document.addEventListener("selectionchange", listener)
      try {
        expect(state.dispatch(selectionChange(eventId + 100))).toBe(false)
        expect(seen).toEqual([])
      } finally {
        document.removeEventListener("selectionchange", listener)
      }
    })

    it("turns native's selectionChange on while a listener exists, besides the root's own", () => {
      const { fake, eventId } = mountWindow()
      const sync = syncWindowSelectionChange(fake, eventId, () => false)
      const listener = () => {}
      document.addEventListener("selectionchange", listener)
      document.removeEventListener("selectionchange", listener)
      sync.stop()
      expect(fake.selectionChangeCalls).toEqual([
        [false, eventId],
        [true, eventId],
        [false, eventId],
        [false, eventId],
      ])
      const wanted = syncWindowSelectionChange(fake, eventId, () => true)
      expect(fake.selectionChangeCalls.at(-1)).toEqual([true, eventId])
      wanted.stop()
    })
  })
})
