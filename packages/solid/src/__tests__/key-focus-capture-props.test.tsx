/** `onKeyDownCapture`, `onKeyUpCapture`, `onFocusCapture`, `onBlurCapture` and the `focusin` and `focusout` twins: the capture phase of key and focus events. */
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("Solid capture props of key and focus events", () => {
  function mount(log: string[], options: { stopInCapture?: boolean } = {}) {
    const app = createTestRoot()
    app.render(() => (
      <div
        testId="outer"
        style={{ width: 200, height: 100 }}
        onKeyDownCapture={(event) => {
          log.push(`outer keydown capture ${event.eventPhase}`)
          if (options.stopInCapture) event.stopPropagation()
        }}
        onKeyDown={() => log.push("outer keydown")}
        onKeyUpCapture={() => log.push("outer keyup capture")}
        onFocusInCapture={() => log.push("outer focusin capture")}
        onFocusOutCapture={() => log.push("outer focusout capture")}
      >
        <div testId="a" tabIndex={0} style={{ width: 40, height: 20 }} onKeyDown={() => log.push("a keydown")} onFocusIn={() => log.push("a focusin")} />
        <div testId="b" tabIndex={0} style={{ width: 40, height: 20 }} onFocusIn={() => log.push("b focusin")} />
      </div>
    ))
    return { app, id: (testId: string) => app.renderer.findByTestId(testId)!.id }
  }

  it("runs the ancestor's key capture handlers before the target's, then the bubble", () => {
    const log: string[] = []
    const mounted = mount(log)
    mounted.app.renderer.nativeSimulateKeystrokes(mounted.id("a"), "x")
    expect(log.filter((entry) => entry.includes("key"))).toEqual([
      "outer keydown capture 1",
      "a keydown",
      "outer keydown",
      "outer keyup capture",
    ])
    mounted.app.unmount()
  })

  it("lets a capture handler stop the event before it reaches the target", () => {
    const log: string[] = []
    const mounted = mount(log, { stopInCapture: true })
    mounted.app.renderer.nativeSimulateKeystrokes(mounted.id("a"), "x")
    expect(log).not.toContain("a keydown")
    expect(log).not.toContain("outer keydown")
    mounted.app.unmount()
  })

  it("runs the focusin and focusout capture handlers of an ancestor around a focus change", () => {
    const log: string[] = []
    const mounted = mount(log)
    mounted.app.renderer.focusElement(mounted.id("a"))
    mounted.app.renderer.dispatchNativeEvents()
    mounted.app.renderer.focusElement(mounted.id("b"))
    mounted.app.renderer.dispatchNativeEvents()
    expect(log).toEqual([
      "outer focusin capture",
      "a focusin",
      "outer focusout capture",
      "outer focusin capture",
      "b focusin",
    ])
    mounted.app.unmount()
  })
})
