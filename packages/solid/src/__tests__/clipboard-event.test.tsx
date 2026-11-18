/** `ClipboardEvent` and `DataTransfer` as globals, and the `onCopy`, `onCut` and `onPaste` props, in Solid. */
import { afterEach, describe, expect, it } from "vitest"
import type { DomEvent } from "@ghia/native/host"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("clipboard events in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  afterEach(() => app.unmount())

  function mount(handlers: Record<string, (event: DomEvent) => void>) {
    app = createTestRoot()
    let outer!: HostElement
    let inner!: HostElement
    app.render(() => (
      <div ref={outer} testId="outer" style={{ width: 200, height: 100 }} {...handlers}>
        <div ref={inner} testId="inner" tabIndex={0} style={{ width: 100, height: 60 }} />
      </div>
    ))
    return { outer, inner }
  }

  it.each([
    ["copy", "onCopy"],
    ["cut", "onCut"],
    ["paste", "onPaste"],
  ])("runs %s through %s and a listener, with its clipboardData", (type, prop) => {
    const calls: string[] = []
    const nodes = mount({
      [prop]: (event: DomEvent) => {
        const data = (event as unknown as ClipboardEvent).clipboardData
        calls.push(`${event.type} ${event.eventPhase} ${data?.getData("text/plain")}`)
        event.preventDefault()
      },
      [`${prop}Capture`]: (event: DomEvent) => calls.push(`capture ${event.eventPhase}`),
    })
    nodes.outer.addEventListener(type, (() => calls.push("listener")) as never)
    const clipboardData = new globalThis.DataTransfer()
    clipboardData.setData("text/plain", "hi")
    const event = new globalThis.ClipboardEvent(type, { clipboardData, bubbles: true, cancelable: true })
    expect(nodes.inner.dispatchEvent(event)).toBe(false)
    expect(calls).toEqual(["capture 1", `${type} 3 hi`, "listener"])
    expect(event.clipboardData).toBe(clipboardData)
  })
})

describe("clipboard globals in Solid", () => {
  it("installs DataTransfer and ClipboardEvent as globals", () => {
    expect(globalThis.ClipboardEvent.name).toBe("ClipboardEvent")
    expect(globalThis.DataTransfer.name).toBe("DataTransfer")
    expect(new globalThis.DataTransfer()).toBeInstanceOf(globalThis.DataTransfer)
  })
})
