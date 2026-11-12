// @ts-nocheck
/**
 * A library keeps an element past the unmount of its root and reaches it from a timer or a
 * microtask (Base UI's focus return, floating-ui's measuring). The element then reads as a node
 * that is not in a document, and nothing reaches the window of a later test.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function reachStaleElement(element: HTMLElement) {
  const results: Record<string, unknown> = {}
  const listener = () => {}
  element.addEventListener("focus", listener)
  results.rect = element.getBoundingClientRect()
  results.computedDisplay = getComputedStyle(element).display
  element.focus()
  element.blur()
  element.style.width = "10px"
  element.setAttribute("data-late", "1")
  element.removeEventListener("focus", listener)
  results.matchesFocus = element.matches(":focus")
  element.scrollIntoView()
  new ResizeObserver(() => {}).observe(element)
  return results
}

describeNative("an element used after its root unmounted", () => {
  it("reads as a node that is not in a document from a timer and a microtask", async () => {
    let element: HTMLElement | null = null
    const root = createTestRoot({ width: 200, height: 100 })
    root.render(
      <button ref={(value) => value && (element = value)} style={{ width: 80, height: 24 }}>
        Open
      </button>
    )
    root.unmount()

    const fromMicrotask = new Promise((resolve, reject) =>
      queueMicrotask(() => {
        try {
          resolve(reachStaleElement(element))
        } catch (error) {
          reject(error)
        }
      })
    )
    const fromTimer = new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(reachStaleElement(element))
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
    let stale: HTMLElement | null = null
    const first = createTestRoot({ width: 200, height: 100 })
    first.render(<button ref={(value) => value && (stale = value)} style={{ width: 80, height: 24 }} />)

    // Ids start from the same number in every renderer, so `stale.focus()` names the second
    // window's button if it reaches it.
    const second = createTestRoot({ width: 200, height: 100 })
    second.render(<button testId="other" style={{ width: 80, height: 24 }} />)
    expect(second.renderer.getFocusedElementId()).toBeNull()

    stale.focus()
    expect(second.renderer.getFocusedElementId()).toBeNull()
    expect(stale.getBoundingClientRect().width).toBe(0)
    second.unmount()
  })

  it("throws an ordinary error when two handlers move focus back and forth", () => {
    const refs: Record<string, HTMLElement | null> = { a: null, b: null }
    const root = createTestRoot({ width: 200, height: 100 })
    root.render(
      <>
        <button ref={(value) => (refs.a = value)} onFocus={() => refs.b.focus()} style={{ width: 80, height: 24 }} />
        <button ref={(value) => (refs.b = value)} onFocus={() => refs.a.focus()} style={{ width: 80, height: 24 }} />
      </>
    )
    // Without a limit on nested handler calls the loop exhausts the stack inside napi, which
    // aborts the process instead of throwing.
    expect(() => refs.a.focus()).toThrow(/Maximum call stack size exceeded/)
    root.unmount()
  })
})
