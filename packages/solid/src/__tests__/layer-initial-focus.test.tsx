/**
 * A layer's `initialFocus` and `finalFocus` target is focused by what the tree has now, not by what native last received:
 * an element mounted, shown or made focusable in the same update as the layer opens takes the focus.
 */
import { createSignal, Show } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { DismissableLayer } from "../components/floating.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("layer focus targets, in Solid", () => {
  let app: ReturnType<typeof createTestRoot> | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  const focusedTestId = () => app!.renderer.getElement(app!.renderer.getFocusedElementId()!)?.testId

  it("focuses a target the same update mounted", () => {
    const [open, setOpen] = createSignal(false)
    app = createTestRoot({ width: 400, height: 300 })
    let target!: HTMLElement
    app.render(() => (
      <div>
        <div autoFocus tabIndex={0} testId="launcher" style={{ width: 40, height: 20 }} />
        <Show when={open()}>
          <DismissableLayer onEscapeKeyDown={() => setOpen(false)} initialFocus={() => (target as unknown as { nativeId: number }).nativeId}>
            <div ref={target} tabIndex={0} testId="inside" style={{ width: 40, height: 20 }} />
          </DismissableLayer>
        </Show>
      </div>
    ))
    expect(focusedTestId()).toBe("launcher")
    app.flushSync(() => setOpen(true))
    expect(focusedTestId()).toBe("inside")
  })

  it("judges a target whose tabIndex changes in the same update by the new value", () => {
    const [open, setOpen] = createSignal(false)
    app = createTestRoot({ width: 400, height: 300 })
    let target!: HTMLElement
    app.render(() => (
      <div>
        <div autoFocus tabIndex={0} testId="launcher" style={{ width: 40, height: 20 }} />
        <div ref={target} tabIndex={open() ? 0 : undefined} testId="target" style={{ width: 40, height: 20 }} />
        <Show when={open()}>
          <DismissableLayer onEscapeKeyDown={() => setOpen(false)} initialFocus={() => (target as unknown as { nativeId: number }).nativeId} />
        </Show>
      </div>
    ))
    app.flushSync(() => setOpen(true))
    expect(focusedTestId()).toBe("target")
  })

  it("does not focus a target the same update hides", () => {
    const [open, setOpen] = createSignal(false)
    app = createTestRoot({ width: 400, height: 300 })
    let target!: HTMLElement
    app.render(() => (
      <div>
        <div autoFocus tabIndex={0} testId="launcher" style={{ width: 40, height: 20 }} />
        <div ref={target} tabIndex={0} testId="target" style={{ width: 40, height: 20, display: open() ? "none" : "block" }} />
        <Show when={open()}>
          <DismissableLayer onEscapeKeyDown={() => setOpen(false)} initialFocus={() => (target as unknown as { nativeId: number }).nativeId} />
        </Show>
      </div>
    ))
    app.flushSync(() => setOpen(true))
    expect(focusedTestId()).toBe("launcher")
  })
})
