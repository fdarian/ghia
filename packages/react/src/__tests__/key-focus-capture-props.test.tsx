/** `onKeyDownCapture`, `onKeyUpCapture`, `onFocusCapture` and `onBlurCapture`: the capture phase of key and focus events, as in React DOM. */
// @ts-nocheck

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("capture props of key and focus events", () => {
  function mount(log: string[], options: { stopInCapture?: boolean } = {}) {
    const root = createTestRoot()
    root.render(
      <div
        testId="outer"
        style={{ width: 200, height: 100 }}
        onKeyDownCapture={(event) => {
          log.push(`outer keydown capture ${event.eventPhase}`)
          if (options.stopInCapture) event.stopPropagation()
        }}
        onKeyDown={() => log.push("outer keydown")}
        onKeyUpCapture={() => log.push("outer keyup capture")}
        onFocusCapture={() => log.push("outer focus capture")}
        onBlurCapture={() => log.push("outer blur capture")}
      >
        <div testId="a" tabIndex={0} style={{ width: 40, height: 20 }} onKeyDown={() => log.push("a keydown")} onFocus={() => log.push("a focus")} />
        <div testId="b" tabIndex={0} style={{ width: 40, height: 20 }} onFocus={() => log.push("b focus")} />
      </div>
    )
    return { root, id: (testId: string) => root.renderer.findByTestId(testId).id }
  }

  it("runs the ancestor's key capture handlers before the target's, then the bubble", () => {
    const log: string[] = []
    const app = mount(log)
    app.root.renderer.nativeSimulateKeystrokes(app.id("a"), "x")
    expect(log.filter((entry) => entry.includes("key"))).toEqual([
      "outer keydown capture 1",
      "a keydown",
      "outer keydown",
      "outer keyup capture",
    ])
    app.root.unmount()
  })

  it("lets a capture handler stop the event before it reaches the target", () => {
    const log: string[] = []
    const app = mount(log, { stopInCapture: true })
    app.root.renderer.nativeSimulateKeystrokes(app.id("a"), "x")
    expect(log).not.toContain("a keydown")
    expect(log).not.toContain("outer keydown")
    app.root.unmount()
  })

  it("runs onFocusCapture and onBlurCapture of an ancestor around the focus change, as React's bubbling focus does", () => {
    const log: string[] = []
    const app = mount(log)
    app.root.renderer.focusElement(app.id("a"))
    app.root.renderer.dispatchNativeEvents()
    app.root.renderer.focusElement(app.id("b"))
    app.root.renderer.dispatchNativeEvents()
    expect(log).toEqual([
      "outer focus capture",
      "a focus",
      "outer blur capture",
      "outer focus capture",
      "b focus",
    ])
    app.root.unmount()
  })
})
