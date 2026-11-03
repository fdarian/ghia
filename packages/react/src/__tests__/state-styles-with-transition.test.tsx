// @ts-nocheck
/**
 * Whether a state style applies never depends on `transition`: the element with a transition is
 * built through the CSS transition path, which has to read the same focus state as the one
 * without. `GPUIX_BACKGROUND=1`, as an agent drives a window that is not key.
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

const ring = { boxShadow: "0 0 0 3px #ff0000" }
const outlineRing = { outline: "3px solid #ff0000", outlineOffset: 0 }
const BASE = "#dddddd"

type Case = { name: string; transition?: string; style?: Record<string, unknown> }

const cases: Case[] = [
  { name: "no transition" },
  { name: "background-color shorthand", transition: "background-color 100ms" },
  {
    name: "longhands",
    style: { transitionProperty: "background-color", transitionDuration: "100ms" },
  },
  { name: "box-shadow", transition: "box-shadow 100ms" },
]

function box(testId: string, entry: Case, extra = {}) {
  return (
    <div
      testId={testId}
      tabIndex={0}
      style={{
        width: 100,
        height: 40,
        backgroundColor: BASE,
        ...(entry.transition ? { transition: entry.transition } : {}),
        ...entry.style,
        ...extra,
      }}
    />
  )
}

function open(content: React.ReactNode) {
  const root = createTestRoot({ width: 400, height: 400 })
  root.render(
    <div style={{ width: 360, padding: 30, display: "flex", flexDirection: "column", gap: 40 }}>
      {content}
    </div>
  )
  root.renderer.clockPause()
  root.renderer.flush()
  const renderer = root.renderer
  const idOf = (testId: string) => renderer.findByTestId(testId).id
  const boundsOf = (testId: string) => renderer.getElementBounds(idOf(testId))
  const pixels = () => {
    const file = `${SHOTS_DIR}/state-styles-transition-${process.pid}.png`
    fs.rmSync(file, { force: true })
    renderer.captureScreenshot(file)
    return readLogicalPixels(file, renderer)
  }
  const inside = (testId: string) => {
    const bounds = boundsOf(testId)
    return pixels().at(bounds.x + 50, bounds.y + 20).slice(0, 3)
  }
  /** The pixel just outside the left edge, where a 3px ring or an outline draws. */
  const edge = (testId: string) => {
    const bounds = boundsOf(testId)
    return pixels().at(bounds.x - 2, bounds.y + 20).slice(0, 3)
  }
  const center = (testId: string) => {
    const bounds = boundsOf(testId)
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
  }
  return { root, renderer, idOf, boundsOf, inside, edge, center }
}

const RED = [255, 0, 0]
const NONE = [0, 0, 0]

describeNative(":focus-visible does not depend on transition", () => {
  for (const entry of cases) {
    describe(entry.name, () => {
      it("a script focus before any key matches and shows the ring", () => {
        const { root, renderer, idOf, edge } = open(box("a", entry, { focusVisible: ring }))
        expect(edge("a")).toEqual(NONE)
        renderer.focusElement(idOf("a"))
        renderer.clockFastForward(2500)
        expect(renderer.getFocusedElementId()).toBe(idOf("a"))
        expect(renderer.matchesFocus(idOf("a"), ":focus-visible")).toBe(true)
        expect(edge("a")).toEqual(RED)
        root.unmount()
      })

      it("an outline ring shows too", () => {
        const { root, renderer, idOf, edge } = open(box("a", entry, { focusVisible: outlineRing }))
        renderer.focusElement(idOf("a"))
        renderer.clockFastForward(2500)
        expect(edge("a")).toEqual(RED)
        root.unmount()
      })

      it("after a Tab, focusElement and Tab both show it", () => {
        const { root, renderer, idOf, edge } = open(
          <>
            {box("a", entry, { focusVisible: ring })}
            {box("b", entry, { focusVisible: ring })}
          </>
        )
        renderer.simulateKeystrokes("Tab")
        renderer.clockFastForward(2500)
        expect(renderer.getFocusedElementId()).toBe(idOf("a"))
        expect(edge("a")).toEqual(RED)
        renderer.focusElement(idOf("b"))
        renderer.clockFastForward(2500)
        expect(renderer.matchesFocus(idOf("b"), ":focus-visible")).toBe(true)
        expect(edge("b")).toEqual(RED)
        expect(edge("a")).toEqual(NONE)
        root.unmount()
      })

      it("a script focus after a click on a non-text element does not match, and shows no ring", () => {
        const { root, renderer, idOf, edge, center } = open(
          <>
            {box("a", entry, { focusVisible: ring })}
            {box("b", entry, { focusVisible: ring })}
          </>
        )
        renderer.nativeSimulateClick(...center("a"))
        renderer.clockFastForward(2500)
        expect(renderer.getFocusedElementId()).toBe(idOf("a"))
        expect(renderer.matchesFocus(idOf("a"), ":focus-visible")).toBe(false)
        expect(edge("a")).toEqual(NONE)
        renderer.focusElement(idOf("b"))
        renderer.clockFastForward(2500)
        expect(renderer.matchesFocus(idOf("b"), ":focus-visible")).toBe(false)
        expect(edge("b")).toEqual(NONE)
        root.unmount()
      })

      it("a text control focused by a click always shows it", () => {
        const { root, renderer, idOf, edge, center } = open(
          <input
            testId="t"
            style={{
              width: 100,
              height: 40,
              backgroundColor: BASE,
              ...(entry.transition ? { transition: entry.transition } : {}),
              ...entry.style,
              focusVisible: ring,
            }}
          />
        )
        renderer.nativeSimulateClick(...center("t"))
        renderer.clockFastForward(2500)
        expect(renderer.matchesFocus(idOf("t"), ":focus-visible")).toBe(true)
        expect(edge("t")).toEqual(RED)
        root.unmount()
      })
    })
  }

  it("a Tab then a click then a script focus follows the left element, with a transition", () => {
    const entry = cases[1]!
    const { root, renderer, idOf, edge, center } = open(
      <>
        {box("a", entry, { focusVisible: ring })}
        {box("b", entry, { focusVisible: ring })}
      </>
    )
    renderer.simulateKeystrokes("Tab")
    renderer.nativeSimulateClick(...center("b"))
    renderer.clockFastForward(2500)
    expect(renderer.matchesFocus(idOf("b"), ":focus-visible")).toBe(false)
    expect(edge("b")).toEqual(NONE)
    root.unmount()
  })
})

describeNative("a transition still runs when the focus style changes a transitioned property", () => {
  const style = (extra = {}) => ({
    transition: "background-color 1s linear",
    focusVisible: { backgroundColor: "#000000" },
    ...extra,
  })

  it("on a script focus before any key", () => {
    const { root, renderer, idOf, inside } = open(box("a", { name: "t", style: style() }))
    expect(inside("a")).toEqual([221, 221, 221])
    renderer.focusElement(idOf("a"))
    renderer.clockFastForward(500)
    const middle = inside("a")[0]
    expect(middle).toBeGreaterThan(80)
    expect(middle).toBeLessThan(140)
    renderer.clockFastForward(600)
    expect(inside("a")).toEqual([0, 0, 0])
    root.unmount()
  })

  it("on Tab, and back when focus leaves", () => {
    const { root, renderer, idOf, inside } = open(box("a", { name: "t", style: style() }))
    renderer.simulateKeystrokes("Tab")
    renderer.clockFastForward(500)
    const middle = inside("a")[0]
    expect(middle).toBeGreaterThan(80)
    expect(middle).toBeLessThan(140)
    renderer.clockFastForward(600)
    expect(inside("a")).toEqual([0, 0, 0])
    renderer.blurElement(idOf("a"))
    renderer.clockFastForward(500)
    const back = inside("a")[0]
    expect(back).toBeGreaterThan(80)
    expect(back).toBeLessThan(140)
    renderer.clockFastForward(600)
    expect(inside("a")).toEqual([221, 221, 221])
    root.unmount()
  })

  it("does not start one on a click focus, where the style does not match", () => {
    const { root, renderer, center, inside } = open(box("a", { name: "t", style: style() }))
    renderer.nativeSimulateClick(...center("a"))
    renderer.clockFastForward(500)
    expect(inside("a")).toEqual([221, 221, 221])
    root.unmount()
  })
})

describeNative("the other state styles with a transition on the element", () => {
  const transition = "background-color 1s linear"
  const colours = { backgroundColor: BASE, transition }

  it(":hover runs its transition and reaches its colour", () => {
    const { root, renderer, center, inside } = open(
      box("a", { name: "t" }, { ...colours, hover: { backgroundColor: "#000000" } })
    )
    renderer.nativeSimulateMouseMove(...center("a"))
    renderer.clockFastForward(500)
    const middle = inside("a")[0]
    expect(middle).toBeGreaterThan(80)
    expect(middle).toBeLessThan(140)
    renderer.clockFastForward(600)
    expect(inside("a")).toEqual([0, 0, 0])
    root.unmount()
  })

  it(":active runs its transition and reaches its colour", () => {
    const { root, renderer, center, inside } = open(
      box("a", { name: "t" }, { ...colours, active: { backgroundColor: "#000000" } })
    )
    renderer.nativeSimulateMouseDown(...center("a"), 0)
    renderer.clockFastForward(500)
    const middle = inside("a")[0]
    expect(middle).toBeGreaterThan(80)
    expect(middle).toBeLessThan(140)
    renderer.clockFastForward(600)
    expect(inside("a")).toEqual([0, 0, 0])
    renderer.nativeSimulateMouseUp(...center("a"), 0)
    root.unmount()
  })

  it(":focus-within and :has(:focus) on a transitioned parent, by a script focus before any key", () => {
    const { root, renderer, idOf, inside } = open(
      <>
        <div
          testId="within"
          style={{ width: 100, height: 40, backgroundColor: BASE, transition, focusWithin: { backgroundColor: "#000000" } }}
        >
          <div testId="a" tabIndex={0} style={{ width: 20, height: 20 }} />
        </div>
        <div
          testId="has"
          style={{ width: 100, height: 40, backgroundColor: BASE, transition, hasFocus: { backgroundColor: "#000000" } }}
        >
          <div testId="b" tabIndex={0} style={{ width: 20, height: 20 }} />
        </div>
      </>
    )
    renderer.focusElement(idOf("a"))
    renderer.clockFastForward(2500)
    expect(renderer.matchesFocus(idOf("within"), ":focus-within")).toBe(true)
    expect(renderer.matchesFocus(idOf("a"), ":focus")).toBe(true)
    expect(inside("within")).toEqual([0, 0, 0])
    expect(inside("has")).toEqual([221, 221, 221])
    renderer.focusElement(idOf("b"))
    renderer.clockFastForward(2500)
    expect(inside("has")).toEqual([0, 0, 0])
    expect(inside("within")).toEqual([221, 221, 221])
    root.unmount()
  })

  it(":has(:focus-visible) on a transitioned parent follows the same heuristic", () => {
    const { root, renderer, idOf, inside } = open(
      <div
        testId="has"
        style={{ width: 100, height: 40, backgroundColor: BASE, transition, hasFocusVisible: { backgroundColor: "#000000" } }}
      >
        <div testId="a" tabIndex={0} style={{ width: 20, height: 20 }} />
      </div>
    )
    renderer.focusElement(idOf("a"))
    renderer.clockFastForward(2500)
    expect(inside("has")).toEqual([0, 0, 0])
    root.unmount()
  })
})
