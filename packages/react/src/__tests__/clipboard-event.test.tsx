/** `ClipboardEvent` and `DataTransfer` as globals, and the `onCopy`, `onCut` and `onPaste` props, in React. */
import { afterEach, describe, expect, it } from "vitest"
import type { DomEvent } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { PublicInstance } from "../types/host.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("clipboard events in React", () => {
  let testRoot: ReturnType<typeof createTestRoot>

  afterEach(() => testRoot.unmount())

  function mount(handlers: Record<string, (event: DomEvent) => void>) {
    testRoot = createTestRoot()
    const instances: Record<string, PublicInstance> = {}
    const ref = (name: string) => (instance: unknown) => {
      if (instance) instances[name] = instance as PublicInstance
    }
    testRoot.render(
      <div ref={ref("outer")} testId="outer" style={{ width: 200, height: 100 }} {...handlers}>
        <div ref={ref("inner")} testId="inner" tabIndex={0} style={{ width: 100, height: 60 }} />
      </div>
    )
    return instances
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

describe("clipboard globals in React", () => {
  it("installs DataTransfer and ClipboardEvent as globals", () => {
    expect(globalThis.ClipboardEvent.name).toBe("ClipboardEvent")
    expect(globalThis.DataTransfer.name).toBe("DataTransfer")
    expect(new globalThis.DataTransfer()).toBeInstanceOf(globalThis.DataTransfer)
  })
})
