/**
 * What a burst of `el.style` writes costs: a drag handler that writes a dozen properties on a
 * hundred elements on every pointer move. The writes are collected into one `setStyle` per element
 * for the flush, so native gets the last style of each element, with nothing in it for a property
 * Ghia has no style key for. The time is printed, not asserted: it depends on the machine.
 */
import { afterEach, describe, expect, it } from "vitest"
import "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("element.style write burst in React", () => {
  let app: ReturnType<typeof createTestRoot> | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  const writers: Array<(style: CSSStyleDeclaration, step: number) => void> = [
    (style, step) => (style.width = `${10 + (step % 50)}px`),
    (style, step) => (style.height = `${5 + (step % 30)}px`),
    (style, step) => (style.opacity = String((step % 10) / 10)),
    (style, step) => (style.transform = `translate(${step % 40}px, ${step % 20}px)`),
    (style, step) => style.setProperty("--drag-x", `${step}px`),
    (style, step) => style.setProperty("color", `rgb(${step % 255}, 0, 0)`),
    (style, step) => style.setProperty("touch-action", step % 2 === 0 ? "none" : "pan-x"),
    (style, step) => (style.marginLeft = `${step % 7}px`),
    (style, step) => style.setProperty("pointer-events", step % 2 === 0 ? "none" : "auto"),
    (style, step) => (style.zIndex = String(step % 9)),
  ]

  function mountElements(count: number): HTMLElement[] {
    app = createTestRoot({ width: 400, height: 300 })
    const elements: HTMLElement[] = []
    app.render(
      <div>
        {Array.from({ length: count }, (_value, index) => (
          <div key={index} ref={(instance) => instance && (elements[index] = instance as unknown as HTMLElement)} style={{ width: 20, height: 10 }} />
        ))}
      </div>
    )
    return elements
  }

  /** The flush is the microtask that sends each element's style once, then the renderer applying it. */
  async function burst(elements: HTMLElement[], total: number): Promise<{ writeMs: number; flushMs: number }> {
    const started = performance.now()
    for (let step = 0; step < total; step += 1) {
      const element = elements[step % elements.length]
      writers[step % writers.length](element.style, step)
    }
    const written = performance.now()
    await Promise.resolve()
    await Promise.resolve()
    app!.renderer.flush()
    const flushed = performance.now()
    return { writeMs: written - started, flushMs: flushed - written }
  }

  for (const count of [1, 100]) {
    it(`1000 mixed writes on ${count} element${count === 1 ? "" : "s"} reach native as the last style, and the flush is measured`, async () => {
      const elements = mountElements(count)
      await burst(elements, 1000)
      const runs: Array<Awaited<ReturnType<typeof burst>>> = []
      for (let run = 0; run < 7; run += 1) runs.push(await burst(elements, 1000))
      const median = (pick: (run: (typeof runs)[number]) => number) => runs.map(pick).sort((a, b) => a - b)[3]
      process.stderr.write(
        `1000 style writes on ${count} element(s): write ${median((run) => run.writeMs).toFixed(2)} ms, flush ${median((run) => run.flushMs).toFixed(2)} ms, total ${median((run) => run.writeMs + run.flushMs).toFixed(2)} ms\n`
      )
      for (const element of elements) {
        const sent = app!.renderer.getElement((element as unknown as { nativeId: number }).nativeId)!.style as Record<string, unknown>
        expect(Object.keys(sent).filter((key) => /touch/i.test(key))).toEqual([])
        if (element.style.width !== "") expect(sent.width).toBe(Number.parseFloat(element.style.width))
      }
    })
  }
})
