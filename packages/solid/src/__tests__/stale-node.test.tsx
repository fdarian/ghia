/**
 * A library keeps an element past the unmount of its root and reaches it from a timer or a
 * microtask (Base UI's focus return, floating-ui's measuring). The element then reads as a node
 * that is not in a document, and nothing reaches the window of a later test.
 */

import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

function reachStaleElement(element: HTMLElement) {
  const listener = () => {}
  element.addEventListener("focus", listener)
  const rect = element.getBoundingClientRect()
  const computedDisplay = getComputedStyle(element).display
  element.focus()
  element.blur()
  element.style.width = "10px"
  element.setAttribute("data-late", "1")
  element.removeEventListener("focus", listener)
  const matchesFocus = element.matches(":focus")
  element.scrollIntoView()
  new ResizeObserver(() => {}).observe(element)
  return { rect, computedDisplay, matchesFocus }
}

describe.skipIf(!hasNativeTestRenderer)("an element used after its root unmounted", () => {
  it("reads as a node that is not in a document from a timer and a microtask", async () => {
    let element: HTMLElement | undefined
    const app = createTestRoot({ width: 200, height: 100 })
    app.render(() => (
      <button ref={(value: HTMLElement) => (element = value)} style={{ width: 80, height: 24 }}>
        Open
      </button>
    ))
    app.unmount()
    const stale = element
    if (stale === undefined) throw new Error("The ref was not called")

    const fromMicrotask = new Promise<ReturnType<typeof reachStaleElement>>((resolve, reject) =>
      queueMicrotask(() => {
        try {
          resolve(reachStaleElement(stale))
        } catch (error) {
          reject(error)
        }
      })
    )
    const fromTimer = new Promise<ReturnType<typeof reachStaleElement>>((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(reachStaleElement(stale))
        } catch (error) {
          reject(error)
        }
      }, 5)
    )
    for (const results of await Promise.all([fromMicrotask, fromTimer])) {
      expect(results.rect).toMatchObject({ x: 0, y: 0, width: 0, height: 0 })
      expect(results.computedDisplay).toBe("")
      expect(results.matchesFocus).toBe(false)
    }
  })

  it("does not reach the window of the next renderer", () => {
    let stale: HTMLElement | undefined
    const first = createTestRoot({ width: 200, height: 100 })
    first.render(() => <button ref={(value: HTMLElement) => (stale = value)} style={{ width: 80, height: 24 }} />)

    // Ids start from the same number in every renderer, so `stale.focus()` names the second
    // window's button if it reaches it.
    const second = createTestRoot({ width: 200, height: 100 })
    second.render(() => <button testId="other" style={{ width: 80, height: 24 }} />)
    expect(second.renderer.getFocusedElementId()).toBeNull()

    if (stale === undefined) throw new Error("The ref was not called")
    stale.focus()
    expect(second.renderer.getFocusedElementId()).toBeNull()
    expect(stale.getBoundingClientRect().width).toBe(0)
    second.unmount()
  })

  it("throws an ordinary error when two handlers move focus back and forth", () => {
    let a: HTMLElement | undefined
    let b: HTMLElement | undefined
    const app = createTestRoot({ width: 200, height: 100 })
    app.render(() => (
      <>
        <button ref={(value: HTMLElement) => (a = value)} onFocus={() => b?.focus()} style={{ width: 80, height: 24 }} />
        <button ref={(value: HTMLElement) => (b = value)} onFocus={() => a?.focus()} style={{ width: 80, height: 24 }} />
      </>
    ))
    // Without a limit on nested handler calls the loop exhausts the stack inside napi, which
    // aborts the process instead of throwing.
    expect(() => a?.focus()).toThrow(/Maximum call stack size exceeded/)
    app.unmount()
  })
})
