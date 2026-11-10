// @ts-nocheck
/// `var()` in any style property, read from the custom properties the element computes to, as in Chrome: the way
/// `@base-ui/react` sizes a popup (`width: var(--anchor-width)`, set inline on the Positioner above it).

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { verifying } from "./retained-harness.js"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"
import { motion } from "../index"

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

type Rgba = [number, number, number, number]

/** The pixels of `tree` in a fresh window, read after `before` ran (a pointer move, say). */
function paint(name: string, tree: React.ReactElement, before?: (renderer: Renderer) => void) {
  const root = createTestRoot({ width: 800, height: 600 })
  try {
    root.render(tree)
    root.renderer.flush()
    before?.(root.renderer)
    const file = `${SHOTS_DIR}/var-properties-${name}.png`
    root.renderer.captureScreenshot(file)
    const pixels = readLogicalPixels(file, root.renderer)
    return { at: (x: number, y: number) => pixels.at(x, y) as Rgba }
  } finally {
    root.unmount()
  }
}

const RED: Rgba = [255, 0, 0, 255]
const BLUE: Rgba = [0, 0, 255, 255]

function expectNear(actual: Rgba, expected: Rgba, tolerance = 1) {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(actual[i]! - expected[i]!), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance)
  }
}

describeNative("a var() that the element inherits, animates or is animated over", () => {
  it("reaches the text and the descendants through color and fontSize", () => {
    const tree = (fontSize: string | number | undefined, color: string | undefined) => (
      <div style={{ position: "absolute", left: 0, top: 0, "--s": "24px", "--c": "#ff0000" }}>
        <div testId="host" style={{ position: "absolute", left: 0, top: 0, fontSize, color }}>
          <div testId="em" style={{ width: "10em", height: 5 }} />
          <div testId="swatch" style={{ width: 100, height: 100, backgroundColor: "currentColor" }} />
        </div>
        <div style={{ position: "absolute", left: 300, top: 0, width: 300, fontSize, color }}>
          <text testId="text">measured text</text>
        </div>
      </div>
    )
    const measure = (fontSize: string | number | undefined, color: string | undefined) => {
      let measured: { em: number; textHeight: number } | undefined
      mounted(tree(fontSize, color), (renderer) => {
        measured = { em: box(renderer, "em")[2], textHeight: box(renderer, "text")[3] }
      })
      return measured!
    }
    const viaVar = measure("var(--s)", "var(--c)")
    const plain = measure(24, "#ff0000")
    const unset = measure(undefined, undefined)
    expect(viaVar).toEqual(plain)
    expect(viaVar.em).toBe(240)
    expect(viaVar.textHeight).toBeGreaterThan(unset.textHeight)
    expectNear(paint("color", tree("var(--s)", "var(--c)")).at(50, 50), RED)
  }, SLOW)

  it("starts a transition that a var() declares", () => {
    const sized = (width: number) => (
      <div style={{ position: "absolute", left: 0, top: 0, width: 800, height: 600, "--d": "1s" }}>
        <div testId="box" style={{ position: "absolute", left: 0, top: 0, width, height: 20, transition: "width var(--d) linear" }} />
      </div>
    )
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

  it("lets motion write a property that a var() declares", () => {
    const root = createTestRoot({ width: 800, height: 600 })
    const renderer = root.renderer
    try {
      renderer.clockPause()
      root.render(
        <div style={{ position: "absolute", left: 0, top: 0, "--w": "50px" }}>
          <motion.div
            testId="box"
            style={{ width: "var(--w)", height: 20 }}
            initial={{ width: 100 }}
            animate={{ width: 300 }}
            transition={{ duration: 1, ease: "linear" }}
          />
        </div>,
      )
      renderer.flush()
      renderer.dispatchNativeEvents()
      expect(box(renderer, "box")[2]).toBe(100)
      renderer.clockFastForward(500)
      renderer.dispatchNativeEvents()
      expect(box(renderer, "box")[2]).toBeCloseTo(200, 0)
      renderer.clockFastForward(1000)
      renderer.dispatchNativeEvents()
      expect(box(renderer, "box")[2]).toBeCloseTo(300, 0)
    } finally {
      root.unmount()
    }
  }, SLOW)

  it("resolves a number through opacity", () => {
    const shot = paint(
      "opacity",
      <div style={{ position: "absolute", left: 0, top: 0, "--o": "0.5" }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 100, height: 100, backgroundColor: "#ff0000", opacity: "var(--o)" }} />
        <div style={{ position: "absolute", left: 200, top: 0, width: 100, height: 100, backgroundColor: "#ff0000", opacity: 0.5 }} />
        <div style={{ position: "absolute", left: 400, top: 0, width: 100, height: 100, backgroundColor: "#ff0000" }} />
      </div>,
    )
    expectNear(shot.at(50, 50), shot.at(250, 50))
    expect(shot.at(50, 50)).not.toEqual(shot.at(450, 50))
  }, SLOW)

  it("lets a hovered borderColor win over a border that a var() declares", () => {
    const tree = (
      <div style={{ position: "absolute", left: 10, top: 10, "--line": "#0000ff" }}>
        <div testId="bordered" style={{ width: 60, height: 60, border: "6px solid var(--line)", hover: { borderColor: "#ff0000" } }} />
      </div>
    )
    const at_rest = paint("border-rest", tree)
    expectNear(at_rest.at(13, 40), BLUE)
    const hovered = paint("border-hover", tree, (renderer) => {
      renderer.nativeSimulateMouseMove(40, 40)
    })
    expectNear(hovered.at(13, 40), RED)
  }, SLOW)
})

describeNative("a var() in the style of an inline box", () => {
  const tree = (style: Record<string, unknown>, custom: Record<string, string>) => (
    <div style={{ position: "absolute", left: 0, top: 0, width: 600, ...custom }}>
      <text testId="text">
        ab
        <span testId="span" style={style}>
          WWWW
        </span>
        cd
      </text>
    </div>
  )
  const boxes = (renderer: Renderer) => [box(renderer, "text"), box(renderer, "span")]

  const measured = (spanTree: React.ReactElement) => {
    let found: unknown
    mounted(spanTree, (renderer) => {
      found = boxes(renderer)
    })
    return found
  }

  it.each([
    ["fontSize", "40px", "20px"],
    ["paddingLeft", "40px", "20px"],
  ])("sizes a span by %s, and again when the custom property above it changes", (property, value, changed) => {
    const viaVar = { [property]: "var(--s)" }
    const literal = (to: string) => ({ [property]: to })
    const unset = measured(tree({}, { "--s": value }))
    const expected = measured(tree(literal(value), {}))
    const expectedChanged = measured(tree(literal(changed), {}))
    expect(expected).not.toEqual(unset)
    mounted(tree(viaVar, { "--s": value }), (renderer, root) => {
      expect(boxes(renderer)).toEqual(expected)
      update(root, tree(viaVar, { "--s": changed }))
      expect(boxes(renderer)).toEqual(expectedChanged)
    })
  }, SLOW)

  it("paints a span in a color that a var() declares", () => {
    const painted = (color: string, custom: Record<string, string>) =>
      paint(
        `span-color-${color.replace(/\W/g, "")}`,
        <div style={{ position: "absolute", left: 0, top: 0, width: 600, fontSize: 80, ...custom }}>
          <text>
            <span style={{ color }}>WWWW</span>
          </text>
        </div>,
      )
    const viaVar = painted("var(--c)", { "--c": "#ff0000" })
    const literal = painted("#ff0000", {})
    let red = 0
    for (let x = 0; x < 300; x += 2) {
      for (let y = 0; y < 100; y += 2) {
        const pixel = viaVar.at(x, y)
        expectNear(pixel, literal.at(x, y))
        if (pixel[0] > 200 && pixel[1] < 60) red++
      }
    }
    expect(red).toBeGreaterThan(20)
  }, SLOW)
})

describeNative("a custom property declared in a focus state", () => {
  const tree = (focusVisible: Record<string, unknown>) => (
    <div style={{ position: "absolute", left: 0, top: 0, width: 600, "--w": "40px" }}>
      <div testId="focusable" tabIndex={0} style={{ width: 20, height: 10, focusVisible }} />
    </div>
  )
  const focusedWidth = (focusVisible: Record<string, unknown>) => {
    let width = 0
    mounted(tree(focusVisible), (renderer) => {
      renderer.simulateKeystrokes("Tab")
      renderer.dispatchNativeEvents()
      renderer.flush()
      renderer.drawFrame()
      expect(renderer.matchesFocus(renderer.findByTestId("focusable")!.id, ":focus-visible")).toBe(true)
      width = box(renderer, "focusable")[2]
    })
    return width
  }

  it("is the one a var() in that state reads", () => {
    expect(focusedWidth({ width: 80 })).toBe(80)
    expect(focusedWidth({ "--v": "80px", width: "var(--v)" })).toBe(80)
  }, SLOW)

  it("wins over the one the ancestor declares", () => {
    expect(focusedWidth({ "--w": "80px", width: "var(--w)" })).toBe(80)
  }, SLOW)

  it("falls back to the ancestor's when the state does not declare it", () => {
    expect(focusedWidth({ width: "var(--w)" })).toBe(40)
  }, SLOW)
})
