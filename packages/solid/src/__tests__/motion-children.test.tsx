/// A `motion.*` builds its children once, whatever its props do: the consumer needs no `children()` around them to keep
/// an input (and its focus) through a change of `animate`.
import { createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { motion } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("Solid motion children", () => {
  const focusedId = (app: ReturnType<typeof createTestRoot>) => app.renderer.getFocusedElementId()

  it("keeps an input, and its focus, when animate changes", () => {
    const [opacity, setOpacity] = createSignal(0.5)
    const created: unknown[] = []
    const app = createTestRoot({ width: 300, height: 200 })
    app.renderer.clockPause()
    app.render(() => (
      <motion.div animate={{ opacity: opacity() }} transition={{ duration: 0.1 }}>
        <input testId="field" ref={(element: unknown) => created.push(element)} style={{ width: 100, height: 20 }} />
      </motion.div>
    ))
    const before = app.renderer.findByTestId("field")!.id
    app.renderer.focusElement(before)
    expect(focusedId(app)).toBe(before)

    app.flushSync(() => setOpacity(1))
    app.renderer.clockFastForward(200)
    app.renderer.dispatchNativeEvents()

    expect(created.length).toBe(1)
    expect(app.renderer.findByTestId("field")!.id).toBe(before)
    expect(focusedId(app)).toBe(before)
  })

  it("keeps a span's input, and its focus, when animate changes", () => {
    const [opacity, setOpacity] = createSignal(0.5)
    const created: unknown[] = []
    const app = createTestRoot({ width: 300, height: 200 })
    app.renderer.clockPause()
    app.render(() => (
      <motion.span animate={{ opacity: opacity() }} transition={{ duration: 0.1 }}>
        <input testId="field" ref={(element: unknown) => created.push(element)} style={{ width: 100, height: 20 }} />
      </motion.span>
    ))
    const before = app.renderer.findByTestId("field")!.id
    app.renderer.focusElement(before)

    app.flushSync(() => setOpacity(1))
    app.renderer.clockFastForward(200)
    app.renderer.dispatchNativeEvents()

    expect(created.length).toBe(1)
    expect(focusedId(app)).toBe(before)
  })

  it("keeps an input when a variant label and the transition change", () => {
    const [label, setLabel] = createSignal("rest")
    const [duration, setDuration] = createSignal(0.1)
    const created: unknown[] = []
    const app = createTestRoot({ width: 300, height: 200 })
    app.renderer.clockPause()
    app.render(() => (
      <motion.div
        variants={{ rest: { opacity: 0.5 }, shown: { opacity: 1 } }}
        initial="rest"
        animate={label()}
        transition={{ duration: duration() }}
      >
        <input testId="field" ref={(element: unknown) => created.push(element)} style={{ width: 100, height: 20 }} />
      </motion.div>
    ))
    const before = app.renderer.findByTestId("field")!.id
    app.renderer.focusElement(before)

    app.flushSync(() => setLabel("shown"))
    app.flushSync(() => setDuration(0.3))
    app.renderer.clockFastForward(400)
    app.renderer.dispatchNativeEvents()

    expect(created.length).toBe(1)
    expect(focusedId(app)).toBe(before)
  })
})
