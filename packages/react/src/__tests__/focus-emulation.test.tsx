// @ts-nocheck
/** `GPUIX_BACKGROUND=1`: a window opened with it behaves as active for focus, whether or not the window is key. */

import fs from "node:fs"
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const previous = process.env.GPUIX_BACKGROUND
afterEach(() => {
  if (previous === undefined) delete process.env.GPUIX_BACKGROUND
  else process.env.GPUIX_BACKGROUND = previous
})

function open({ emulate, active }: { emulate: boolean; active: boolean }) {
  if (emulate) process.env.GPUIX_BACKGROUND = "1"
  else delete process.env.GPUIX_BACKGROUND
  const log: string[] = []
  const root = createTestRoot({ width: 300, height: 200 })
  root.render(
    <div style={{ width: 280, height: 120, display: "flex", flexDirection: "column", gap: 10 }}>
      <input
        testId="a"
        style={{ width: 200, height: 30, borderWidth: 2, borderColor: "#888", focusVisible: { borderColor: "#f00" } }}
        onFocus={() => log.push("focus:a")}
        onBlur={() => log.push("blur:a")}
        onChange={(event) => log.push(`change:a:${event.data}`)}
      />
      <input testId="b" style={{ width: 200, height: 30 }} onFocus={() => log.push("focus:b")} onBlur={() => log.push("blur:b")} />
    </div>
  )
  const renderer = root.renderer
  renderer.setWindowActive(active)
  renderer.flush()
  const idOf = (testId: string) => renderer.findByTestId(testId).id
  const center = (testId: string) => {
    const bounds = renderer.getElementBounds(idOf(testId))
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
  }
  const click = (testId: string) => {
    renderer.nativeSimulateClick(...center(testId))
    renderer.flush()
  }
  return { root, renderer, log, idOf, click }
}

const shot = (renderer, name: string): Buffer => {
  const file = `${SHOTS_DIR}/focus-emulation-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureScreenshot(file)
  return fs.readFileSync(file)
}

describeNative("focus emulation (GPUIX_BACKGROUND=1)", () => {
  describe("in a window that is not key", () => {
    it("fires focus and blur on a click, and focus-visible follows the heuristic", () => {
      const { root, renderer, log, idOf, click } = open({ emulate: true, active: false })
      click("a")
      expect(log).toEqual(["focus:a"])
      expect(renderer.matchesFocus(idOf("a"), ":focus")).toBe(true)
      // A text control always matches :focus-visible.
      expect(renderer.matchesFocus(idOf("a"), ":focus-visible")).toBe(true)
      click("b")
      expect(log).toEqual(["focus:a", "blur:a", "focus:b"])
      root.unmount()
    })

    it("fires focus for focusElement and blur for blurElement", () => {
      const { root, renderer, log, idOf } = open({ emulate: true, active: false })
      renderer.focusElement(idOf("b"))
      expect(log).toEqual(["focus:b"])
      expect(renderer.getFocusedElementId()).toBe(idOf("b"))
      renderer.blurElement(idOf("b"))
      expect(log).toEqual(["focus:b", "blur:b"])
      root.unmount()
    })

    it("delivers typed text together with the focus event", () => {
      const { root, renderer, log, click } = open({ emulate: true, active: false })
      click("a")
      renderer.simulateKeystrokes("h i")
      renderer.flush()
      expect(log).toEqual(["focus:a", "change:a:h", "change:a:i"])
      root.unmount()
    })

    it("paints the caret and the focus-visible style", () => {
      const { root, renderer, idOf, click } = open({ emulate: true, active: false })
      const idle = shot(renderer, "idle")
      click("b")
      const caret = shot(renderer, "caret")
      expect(caret.equals(idle), "a caret is drawn in the focused input").toBe(false)
      renderer.blurElement(idOf("b"))
      renderer.flush()
      expect(shot(renderer, "blurred").equals(idle)).toBe(true)
      click("a")
      expect(shot(renderer, "visible").equals(idle), "the focus-visible border and the caret").toBe(false)
      root.unmount()
    })

    it("does not blur the element when the window really becomes inactive or active again", () => {
      const { root, renderer, log, idOf, click } = open({ emulate: true, active: true })
      click("a")
      renderer.setWindowActive(false)
      renderer.flush()
      renderer.setWindowActive(true)
      renderer.flush()
      renderer.setWindowActive(false)
      renderer.flush()
      expect(log).toEqual(["focus:a"])
      expect(renderer.matchesFocus(idOf("a"), ":focus")).toBe(true)
      root.unmount()
    })
  })

  describe("without the variable", () => {
    it("fires no focus event in a window that is not key, and the caret is not drawn", () => {
      const { root, renderer, log, idOf, click } = open({ emulate: false, active: false })
      const idle = shot(renderer, "plain-idle")
      click("b")
      renderer.focusElement(idOf("a"))
      expect(log).toEqual([])
      expect(renderer.matchesFocus(idOf("a"), ":focus")).toBe(false)
      expect(shot(renderer, "plain-focused").equals(idle)).toBe(true)
      root.unmount()
    })

    it("fires them once the window is key", () => {
      const { root, renderer, log, idOf, click } = open({ emulate: false, active: false })
      click("a")
      renderer.setWindowActive(true)
      renderer.flush()
      expect(log).toEqual(["focus:a"])
      renderer.setWindowActive(false)
      renderer.flush()
      expect(log).toEqual(["focus:a", "blur:a"])
      root.unmount()
    })
  })

  it("reads the variable when the window opens, not later", () => {
    const { root, renderer, log, idOf } = open({ emulate: false, active: false })
    process.env.GPUIX_BACKGROUND = "1"
    renderer.focusElement(idOf("a"))
    expect(log).toEqual([])
    root.unmount()
  })
})
