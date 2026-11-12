/** Every event Ghia delivers is an instance of its DOM class, which is also a global, and of `Event`. */
import { afterEach, describe, expect, it } from "vitest"
import { document, window, type DomEvent } from "@ghia/native/host"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

/** What each type a test input can cause is, by the DOM class's global name. */
const CLASS_OF_TYPE: Record<string, string> = {
  pointerover: "PointerEvent",
  pointerenter: "PointerEvent",
  pointermove: "PointerEvent",
  pointerdown: "PointerEvent",
  pointerup: "PointerEvent",
  click: "PointerEvent",
  contextmenu: "PointerEvent",
  mouseover: "MouseEvent",
  mouseenter: "MouseEvent",
  mousemove: "MouseEvent",
  mousedown: "MouseEvent",
  mouseup: "MouseEvent",
  wheel: "WheelEvent",
  keydown: "KeyboardEvent",
  keyup: "KeyboardEvent",
  focus: "FocusEvent",
  focusin: "FocusEvent",
  blur: "FocusEvent",
  focusout: "FocusEvent",
  input: "InputEvent",
  change: "Event",
  dragenter: "DragEvent",
  dragover: "DragEvent",
}

describe.skipIf(!hasNativeTestRenderer)("DOM event classes on events Ghia delivers, in Solid", () => {
  let app: ReturnType<typeof createTestRoot>
  const listeners: Array<[string, (event: DomEvent) => void]> = []

  afterEach(() => {
    for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener, true)
    app.unmount()
  })

  /** Heard through a prop on the element: native emits these only for the element that listens. */
  const PROP_TYPES = new Set(["input", "change", "dragenter", "dragover"])

  function recordAll(seen: Map<string, DomEvent>): void {
    for (const type of Object.keys(CLASS_OF_TYPE).filter((name) => !PROP_TYPES.has(name))) {
      const listener = (event: DomEvent) => seen.set(type, event)
      listeners.push([type, listener])
      window.addEventListener(type, listener, true)
    }
  }

  it("makes each one an instance of its class, of Event and of the class on window", () => {
    const seen = new Map<string, DomEvent>()
    app = createTestRoot({ width: 300, height: 200 })
    let box!: HostElement
    let field!: HostElement
    app.render(() => (
      <div style={{ width: 300, height: 200 }}>
        <div
          ref={box}
          testId="box"
          tabIndex={0}
          style={{ width: 100, height: 60 }}
          onDragEnter={(event) => seen.set("dragenter", event)}
          onDragOver={(event) => {
            seen.set("dragover", event)
            event.preventDefault()
          }}
        />
        <input ref={field} testId="field" style={{ width: 100, height: 30 }} onInput={(event) => seen.set("input", event)} />
      </div>
    ))
    recordAll(seen)
    field.addEventListener("change", (event) => seen.set("change", event as DomEvent))
    const renderer = app.renderer
    const bounds = renderer.getElementBounds(renderer.findByTestId("box")!.id)!
    const x = bounds.x + 10
    const y = bounds.y + 10
    renderer.nativeSimulateMouseMove(x, y)
    renderer.nativeSimulateMouseMove(x + 2, y + 1)
    renderer.nativeSimulateClick(x, y)
    renderer.nativeSimulateClick(x, y, 2)
    renderer.nativeSimulateScrollWheel(x, y, 0, 10)
    box.focus()
    renderer.nativeSimulateKeystrokes(renderer.findByTestId("box")!.id, "a")
    field.focus()
    renderer.nativeSimulateKeystrokes(renderer.findByTestId("field")!.id, "b")
    field.blur()
    renderer.nativeSimulateFileDragEnter(x, y, [import.meta.filename])
    renderer.nativeSimulateFileDragMove(x + 1, y)
    renderer.nativeSimulateFileDragExit()
    renderer.nativeSimulateFileDragEnd()

    expect([...seen.keys()].sort()).toEqual(Object.keys(CLASS_OF_TYPE).sort())
    for (const [type, name] of Object.entries(CLASS_OF_TYPE)) {
      const event = seen.get(type)!
      const cls = Reflect.get(globalThis, name) as new (type: string) => Event
      expect(event, type).toBeInstanceOf(cls)
      expect(event, type).toBeInstanceOf(Event)
      expect(event.isTrusted, type).toBe(true)
      expect(event.type).toBe(type)
    }
    expect(document.defaultView).toBe(globalThis)
  })

  it("gives a keydown handler getModifierState, as Tabs' composite navigation reads Shift", () => {
    app = createTestRoot()
    const seen: Array<[boolean, boolean, boolean, boolean]> = []
    app.render(() => (
      <div
        testId="target"
        tabIndex={0}
        style={{ width: 40, height: 20 }}
        onKeyDown={(event) => {
          expect(event).toBeInstanceOf(globalThis.KeyboardEvent)
          seen.push([event.getModifierState("Shift"), event.getModifierState("Meta"), event.getModifierState("Control"), event.getModifierState("CapsLock")])
        }}
      />
    ))
    app.renderer.nativeSimulateKeystrokes(app.renderer.findByTestId("target")!.id, "Shift+ArrowRight Meta+a b")
    expect(seen).toEqual([
      [true, false, false, false],
      [false, true, false, false],
      [false, false, false, false],
    ])
  })

  it("gives a click handler the held modifiers of a pointer event through getModifierState", () => {
    app = createTestRoot()
    const seen: boolean[] = []
    app.render(() => (
      <div testId="box" style={{ width: 40, height: 20 }} onClick={(event) => seen.push(event.getModifierState("Shift"), event.shiftKey)} />
    ))
    const bounds = app.renderer.getElementBounds(app.renderer.findByTestId("box")!.id)!
    app.renderer.nativeSimulateClick(bounds.x + 5, bounds.y + 5, 0, "Shift")
    app.renderer.nativeSimulateClick(bounds.x + 5, bounds.y + 5)
    expect(seen).toEqual([true, true, false, false])
  })
})
