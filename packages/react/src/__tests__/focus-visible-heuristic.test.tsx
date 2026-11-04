// @ts-nocheck
/**
 * `:focus-visible` as Chrome decides it: two document-level facts, not the visibility of the
 * element focus left. Every sequence below was run in Chrome (Playwright, headless shell, fresh
 * profile: `fv2.py`, `fv3.py` and `fv4.py` of round 48) and the answer is Chrome's, for the element
 * the sequence ends on. Each runs on an element without a transition and on one with, by the ring
 * it paints. `GPUIX_BACKGROUND=1`, as an agent drives a window that is not key.
 */

import fs from "node:fs"
import React from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const previous = process.env.GPUIX_BACKGROUND
beforeEach(() => {
  process.env.GPUIX_BACKGROUND = "1"
})
afterEach(() => {
  if (previous === undefined) delete process.env.GPUIX_BACKGROUND
  else process.env.GPUIX_BACKGROUND = previous
})

const RED = [255, 0, 0]
const NONE = [0, 0, 0]
const ring = { boxShadow: "0 0 0 3px #ff0000" }

/**
 * `tab`: Tab. `key` / `shift` / `ctrl`: a letter, Shift on its own (a modifier change, as the
 * platform reports it), Ctrl+letter. `press:<id>`: a left click on an element (`wchild` is a child
 * of the focusable `w`; `blank` is nothing; `disabled` has nothing focusable either; `p` cancels
 * its mousedown). `rpress:<id>`: the same with the right button. `script:<id>` and `blur`: the
 * script calls.
 */
type Step = string

type Entry = {
  name: string
  steps: Step[]
  /** The element the sequence ends with focused, and whether Chrome says `:focus-visible` matches. */
  focused: string
  visible: boolean
}

const table: Entry[] = [
  { name: "script focus before any input", steps: ["script:a"], focused: "a", visible: true },
  { name: "press on blank body, then script focus", steps: ["press:blank", "script:a"], focused: "a", visible: true },
  { name: "click, then script focus", steps: ["press:a", "script:b"], focused: "b", visible: false },
  { name: "click", steps: ["press:a"], focused: "a", visible: false },
  { name: "Tab", steps: ["tab"], focused: "a", visible: true },
  { name: "Tab, then script focus", steps: ["tab", "script:b"], focused: "b", visible: true },
  { name: "Tab, click blank body, script focus", steps: ["tab", "press:blank", "script:b"], focused: "b", visible: true },
  { name: "Tab, click b", steps: ["tab", "press:b"], focused: "b", visible: false },
  { name: "Tab, click b, script focus a", steps: ["tab", "press:b", "script:a"], focused: "a", visible: false },
  { name: "click text", steps: ["press:t"], focused: "t", visible: true },
  { name: "click, Shift on its own, script focus", steps: ["press:b", "shift", "script:a"], focused: "a", visible: true },
  { name: "click, Ctrl+key, script focus", steps: ["press:b", "ctrl", "script:a"], focused: "a", visible: false },
  { name: "click, key, script focus", steps: ["press:b", "key", "script:a"], focused: "a", visible: true },
  { name: "click, key: the clicked element", steps: ["press:b", "key"], focused: "b", visible: true },
  { name: "click, script focus text", steps: ["press:a", "script:t"], focused: "t", visible: true },
  { name: "click, script focus text, script focus b", steps: ["press:a", "script:t", "script:b"], focused: "b", visible: false },
  { name: "click, key, click blank body, script focus", steps: ["press:a", "key", "press:blank", "script:b"], focused: "b", visible: false },
  { name: "Tab, click the focused element", steps: ["tab", "press:a"], focused: "a", visible: true },
  { name: "Tab, click the focused element, script focus", steps: ["tab", "press:a", "script:b"], focused: "b", visible: true },
  { name: "click a child of a focusable element", steps: ["press:wchild"], focused: "w", visible: false },
  { name: "Tab, click a child of a focusable element, script focus", steps: ["tab", "press:wchild", "script:a"], focused: "a", visible: false },
  { name: "Tab, press on an element that cancels mousedown, script focus", steps: ["tab", "press:p", "script:b"], focused: "b", visible: true },
  { name: "click, key, press on an element that cancels mousedown, script focus", steps: ["press:a", "key", "press:p", "script:b"], focused: "b", visible: true },
  { name: "Tab, click an element that cannot take focus, script focus", steps: ["tab", "press:disabled", "script:b"], focused: "b", visible: true },
  { name: "click, key, click an element that cannot take focus, script focus", steps: ["press:a", "key", "press:disabled", "script:b"], focused: "b", visible: false },
  { name: "Tab, click text, script focus", steps: ["tab", "press:t", "script:b"], focused: "b", visible: false },
  { name: "click, Tab, click blank body, script focus", steps: ["press:a", "tab", "press:blank", "script:a"], focused: "a", visible: true },
  { name: "click, key, click blank body, script focus, click", steps: ["press:a", "key", "press:blank", "script:b", "press:b"], focused: "b", visible: false },
  { name: "click, key, click b, script focus a", steps: ["press:a", "key", "press:b", "script:a"], focused: "a", visible: false },
  { name: "click, script focus, key", steps: ["press:a", "script:b", "key"], focused: "b", visible: true },
  { name: "click, click blank body, script focus", steps: ["press:a", "press:blank", "script:b"], focused: "b", visible: false },
  { name: "click, script blur, script focus", steps: ["press:a", "blur", "script:b"], focused: "b", visible: false },
  { name: "key, script focus, click b, script focus a", steps: ["key", "script:a", "press:b", "script:a"], focused: "a", visible: false },
  { name: "click, key, click the focused element, script focus", steps: ["press:a", "key", "press:a", "script:b"], focused: "b", visible: true },
  { name: "click, key, blur, click blank body, script focus", steps: ["press:a", "key", "blur", "press:blank", "script:b"], focused: "b", visible: true },
  { name: "key, click blank body, script focus", steps: ["key", "press:blank", "script:b"], focused: "b", visible: true },
  { name: "click, key, click text, script focus", steps: ["press:a", "key", "press:t", "script:b"], focused: "b", visible: false },
  { name: "click text, key, click text, script focus", steps: ["press:t", "key", "press:t", "script:b"], focused: "b", visible: true },
  { name: "click, key, click a child, script focus", steps: ["press:a", "key", "press:wchild", "script:b"], focused: "b", visible: false },
  { name: "click a child, key, click it again, script focus", steps: ["press:wchild", "key", "press:wchild", "script:b"], focused: "b", visible: true },
  { name: "click, key, right-click b, script focus a", steps: ["press:a", "key", "rpress:b", "script:a"], focused: "a", visible: false },
]

const variants = [
  { label: "without a transition", style: {} },
  { label: "with a transition", style: { transition: "box-shadow 100ms" } },
]

describeNative(":focus-visible follows Chrome's heuristic", () => {
  for (const variant of variants) {
    describe(variant.label, () => {
      for (const entry of table) {
        it(entry.name, () => {
          const box = (testId: string, extra = {}) => (
            <div
              testId={testId}
              tabIndex={0}
              style={{
                width: 100,
                height: 40,
                backgroundColor: "#dddddd",
                ...variant.style,
                focusVisible: ring,
                ...extra,
              }}
              {...(testId === "p" ? { onMouseDown: (event) => event.preventDefault() } : {})}
            >
              {testId === "w" ? <div testId="wchild" style={{ width: 60, height: 20 }} /> : null}
            </div>
          )
          const root = createTestRoot({ width: 500, height: 500 })
          root.render(
            <div style={{ width: 360, padding: 30, display: "flex", flexDirection: "column", gap: 20 }}>
              {box("a")}
              {box("b")}
              <input
                testId="t"
                style={{ width: 100, height: 40, backgroundColor: "#dddddd", ...variant.style, focusVisible: ring }}
              />
              {box("w")}
              {box("p")}
              <div testId="disabled" style={{ width: 100, height: 40 }} />
            </div>
          )
          const renderer = root.renderer
          renderer.clockPause()
          renderer.flush()
          const idOf = (testId: string) => renderer.findByTestId(testId).id
          const boundsOf = (testId: string) => renderer.getElementBounds(idOf(testId))
          const press = (target: string, button = 0) => {
            const [x, y] =
              target === "blank"
                ? [350, 200]
                : [boundsOf(target).x + 10, boundsOf(target).y + 10]
            renderer.nativeSimulateClick(x, y, button)
          }
          for (const step of entry.steps) {
            if (step === "tab") renderer.simulateKeystrokes("Tab")
            else if (step === "key") renderer.simulateKeystrokes("x")
            else if (step === "ctrl") renderer.simulateKeystrokes("Control+x")
            else if (step === "shift") renderer.nativeSimulateModifiersChanged("shift")
            else if (step === "blur") renderer.blurElement(renderer.getFocusedElementId())
            else if (step.startsWith("press:")) press(step.slice(6))
            else if (step.startsWith("rpress:")) press(step.slice(7), 2)
            else if (step.startsWith("script:")) renderer.focusElement(idOf(step.slice(7)))
            else throw new Error(step)
            // Draw the frame the step asked for, then let a transition run to its end.
            renderer.flush()
            renderer.clockFastForward(2500)
          }
          expect(renderer.getFocusedElementId()).toBe(idOf(entry.focused))
          expect(renderer.matchesFocus(idOf(entry.focused), ":focus-visible")).toBe(entry.visible)
          const file = `${SHOTS_DIR}/focus-visible-heuristic-${process.pid}.png`
          fs.rmSync(file, { force: true })
          renderer.captureScreenshot(file)
          const bounds = boundsOf(entry.focused)
          const edge = readLogicalPixels(file, renderer).at(bounds.x - 2, bounds.y + 20).slice(0, 3)
          expect(edge).toEqual(entry.visible ? RED : NONE)
          root.unmount()
        })
      }
    })
  }
})
