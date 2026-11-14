/**
 * A key that leaves a spread is taken away, as `solid-js/web` does: `solid-js/universal`'s own `spread` only visits
 * the keys it has now, so `data-highlighted` or an `onClick` would stay for good.
 */
import { createSignal } from "solid-js"
import { Dynamic } from "../web.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("a key leaving a spread in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 400, height: 300 })
  })

  afterEach(() => {
    app.unmount()
  })

  it("removes an attribute from an element", () => {
    const [on, setOn] = createSignal(true)
    let box!: HTMLElement
    app.render(() => (
      <div ref={(element: unknown) => (box = element as HTMLElement)} {...(on() ? { "data-x": "", "aria-busy": "true", id: "a" } : {})} />
    ))
    expect([box.getAttribute("data-x"), box.getAttribute("aria-busy"), box.id]).toEqual(["", "true", "a"])

    app.flushSync(() => setOn(false))
    expect([box.getAttribute("data-x"), box.getAttribute("aria-busy"), box.hasAttribute("id")]).toEqual([null, null, false])
    expect(box.hasAttribute("data-x")).toBe(false)

    app.flushSync(() => setOn(true))
    expect(box.getAttribute("data-x")).toBe("")
  })

  it("removes an attribute from a Dynamic host element", () => {
    const [on, setOn] = createSignal(true)
    let box!: HTMLElement
    app.render(() => (
      <Dynamic component="div" ref={(element: unknown) => (box = element as HTMLElement)} {...(on() ? { "data-x": "" } : {})} />
    ))
    expect(box.getAttribute("data-x")).toBe("")
    app.flushSync(() => setOn(false))
    expect(box.hasAttribute("data-x")).toBe(false)
  })

  it("keeps a key that stays and one that a later spread adds", () => {
    const [step, setStep] = createSignal(0)
    let box!: HTMLElement
    const props = () => (step() === 0 ? { "data-a": "1", "data-b": "1" } : step() === 1 ? { "data-b": "2", "data-c": "3" } : {})
    app.render(() => <div ref={(element: unknown) => (box = element as HTMLElement)} {...props()} />)
    const read = () => ["data-a", "data-b", "data-c"].map((name) => box.getAttribute(name))
    expect(read()).toEqual(["1", "1", null])
    app.flushSync(() => setStep(1))
    expect(read()).toEqual([null, "2", "3"])
    app.flushSync(() => setStep(2))
    expect(read()).toEqual([null, null, null])
  })

  it("stops firing a handler that left the spread", () => {
    const clicks: number[] = []
    const [on, setOn] = createSignal(true)
    app.render(() => (
      <div testId="box" style={{ width: 100, height: 100 }} {...(on() ? { onClick: () => clicks.push(1) } : {})} />
    ))
    const bounds = app.renderer.getElementBounds(app.renderer.findByTestId("box")!.id)!
    app.renderer.nativeSimulateClick(bounds.x + 10, bounds.y + 10)
    expect(clicks).toEqual([1])

    app.flushSync(() => setOn(false))
    app.renderer.nativeSimulateClick(bounds.x + 10, bounds.y + 10)
    expect(clicks).toEqual([1])

    app.flushSync(() => setOn(true))
    app.renderer.nativeSimulateClick(bounds.x + 10, bounds.y + 10)
    expect(clicks).toEqual([1, 1])
  })

  it("empties the style that left the spread", () => {
    const [on, setOn] = createSignal(true)
    let box!: HTMLElement
    app.render(() => (
      <div ref={(element: unknown) => (box = element as HTMLElement)} {...(on() ? { style: { width: 40, height: 10 } } : {})} />
    ))
    expect(box.style.width).toBe("40px")
    app.flushSync(() => setOn(false))
    expect(box.style.width).toBe("")
  })
})
