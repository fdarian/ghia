// @ts-nocheck
/// `var()` in any style property, read from the custom properties the element computes to, as in Chrome: the way
/// `@base-ui/react` sizes a popup (`width: var(--anchor-width)`, set inline on the Positioner above it).

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { verifying } from "./retained-harness.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const SLOW = 120_000

type Renderer = ReturnType<typeof createTestRoot>["renderer"]

function box(renderer: Renderer, testId: string): [number, number, number, number] {
  const element = renderer.findByTestId(testId)
  expect(element, `${testId} is mounted`).toBeDefined()
  const bounds = renderer.getElementBounds(element!.id)
  expect(bounds, `${testId} has a box`).not.toBeNull()
  return [bounds!.x, bounds!.y, bounds!.width, bounds!.height]
}

function mounted(tree: React.ReactElement, run: (renderer: Renderer, root: ReturnType<typeof createTestRoot>) => void) {
  const root = createTestRoot({ width: 800, height: 600 })
  try {
    root.render(tree)
    root.renderer.flush()
    run(root.renderer, root)
    if (verifying) expect(root.renderer.getRetainedCounters().mismatches, root.renderer.getRetentionMismatches().join("\n")).toBe(0)
  } finally {
    root.unmount()
  }
}

function update(root: ReturnType<typeof createTestRoot>, tree: React.ReactElement) {
  root.render(tree)
  root.renderer.flush()
  root.renderer.drawFrame()
}

function Positioner({ width, children, custom }: { width: string; children: React.ReactNode; custom?: Record<string, unknown> }) {
  return (
    <div style={{ position: "absolute", left: 10, top: 10, "--w": width, "--h": "40px", ...custom }}>{children}</div>
  )
}

describeNative("var() in any property", () => {
  it("sizes a child by a custom property of its ancestor, and lays it out again when that changes", () => {
    const tree = (width: string) => (
      <Positioner width={width}>
        <div testId="popup" style={{ width: "var(--w)", height: "var(--h)" }} />
      </Positioner>
    )
    mounted(tree("120px"), (renderer, root) => {
      expect(box(renderer, "popup").slice(2)).toEqual([120, 40])
      for (const width of ["200px", "64px", "120px"]) {
        update(root, tree(width))
        expect(box(renderer, "popup").slice(2)).toEqual([Number.parseFloat(width), 40])
      }
    })
  }, SLOW)

  it("lays out again for a change that only a retained subtree below the custom property reads", () => {
    const tree = (width: string) => (
      <div style={{ position: "absolute", left: 0, top: 0, width: 600, height: 400 }}>
        <Positioner width={width}>
          <div style={{ padding: 2 }}>
            <div style={{ display: "flex" }}>
              <div testId="deep" style={{ width: "var(--w)", maxHeight: "calc(var(--h) - 10px)", height: 100 }} />
            </div>
          </div>
        </Positioner>
        <div style={{ position: "absolute", left: 300, top: 0, width: 50, height: 50, backgroundColor: "red" }} />
      </div>
    )
    mounted(tree("50px"), (renderer, root) => {
      expect(box(renderer, "deep").slice(2)).toEqual([50, 30])
      update(root, tree("90px"))
      expect(box(renderer, "deep").slice(2)).toEqual([90, 30])
    })
  }, SLOW)

  it("takes a fallback for a name that is missing, and the initial value for one that cannot be resolved", () => {
    mounted(
      <div style={{ position: "absolute", left: 0, top: 0, width: 400, height: 400 }}>
        <div testId="fallback" style={{ width: "var(--missing, 33px)", height: 10 }} />
        <div testId="initial" style={{ width: "var(--missing)", height: 10 }} />
        <div testId="invalid" style={{ "--w": "red", width: "var(--w)", height: 10 }} />
        <div testId="own" style={{ "--w": "21px", width: "var(--w)", height: 10 }} />
      </div>,
      (renderer) => {
        expect(box(renderer, "fallback")[2]).toBe(33)
        expect(box(renderer, "initial")[2]).toBe(400)
        expect(box(renderer, "invalid")[2]).toBe(400)
        expect(box(renderer, "own")[2]).toBe(21)
      },
    )
  }, SLOW)

  it("orders a shorthand against the plain declarations around it, as written", () => {
    const edge = (testId: string) => box(renderer, `${testId}-inner`)[0] - box(renderer, testId)[0]
    let renderer: Renderer
    mounted(
      <Positioner width="1px" custom={{ "--b": "6px solid red" }}>
        <div testId="shorthand-last" style={{ width: 50, height: 50, borderWidth: "2px", border: "var(--b)" }}>
          <div testId="shorthand-last-inner" style={{ width: 5, height: 5 }} />
        </div>
        <div testId="longhand-last" style={{ width: 50, height: 50, border: "var(--b)", borderWidth: "2px" }}>
          <div testId="longhand-last-inner" style={{ width: 5, height: 5 }} />
        </div>
        <div testId="plain-shorthand-last" style={{ width: 50, height: 50, paddingLeft: "var(--w)", padding: 3 }}>
          <div testId="plain-shorthand-last-inner" style={{ width: 5, height: 5 }} />
        </div>
        <div testId="longhand-after-plain" style={{ width: 50, height: 50, padding: 3, paddingLeft: "var(--w)" }}>
          <div testId="longhand-after-plain-inner" style={{ width: 5, height: 5 }} />
        </div>
      </Positioner>,
      (found) => {
        renderer = found
        expect(edge("shorthand-last")).toBe(6)
        expect(edge("longhand-last")).toBe(2)
        expect(edge("plain-shorthand-last")).toBe(3)
        expect(edge("longhand-after-plain")).toBe(1)
      },
    )
  }, SLOW)

  it("lets a state style that declares the property win over a var() of the base", () => {
    mounted(
      <Positioner width="30px">
        <div testId="plain" style={{ width: "var(--w)", height: 10, hover: { width: 77 } }} />
        <div testId="held" style={{ width: 20, height: 10, hover: { width: "var(--w)" } }} />
      </Positioner>,
      (renderer, root) => {
        expect(box(renderer, "plain")[2]).toBe(30)
        expect(box(renderer, "held")[2]).toBe(20)
        const hover = (testId: string) => {
          const element = renderer.findByTestId(testId)!
          const bounds = renderer.getElementBounds(element.id)!
          renderer.nativeSimulateMouseMove(bounds.x + 2, bounds.y + 2)
          return box(renderer, testId)[2]
        }
        expect(hover("plain")).toBe(77)
        expect(hover("held")).toBe(30)
      },
    )
  }, SLOW)
})

describeNative("a transition of a property that reads a custom property", () => {
  const sized = (width: number) => (
    <div style={{ position: "absolute", left: 0, top: 0, width: 800, height: 600, "--w": `${width}px` }}>
      <div testId="box" style={{ position: "absolute", left: 0, top: 0, width: "var(--w)", height: 20, transition: "width 1s linear" }} />
    </div>
  )

  it("runs from the value computed before the change", () => {
    const root = createTestRoot({ width: 800, height: 600 })
    const renderer = root.renderer
    try {
      renderer.clockPause()
      root.render(sized(100))
      renderer.flush()
      expect(box(renderer, "box")[2]).toBe(100)
      root.render(sized(200))
      renderer.flush()
      expect(box(renderer, "box")[2]).toBe(100)
      renderer.clockFastForward(500)
      renderer.flush()
      renderer.dispatchNativeEvents()
      expect(box(renderer, "box")[2]).toBeCloseTo(150, 1)
      renderer.clockFastForward(500)
      renderer.flush()
      renderer.dispatchNativeEvents()
      expect(box(renderer, "box")[2]).toBe(200)
    } finally {
      root.unmount()
    }
  }, SLOW)
})
