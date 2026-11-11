// @ts-nocheck
/// `var()` in any style property, read from the custom properties the element computes to, as in Chrome: the way
/// `@base-ui/react` sizes a popup (`width: var(--anchor-width)`, set inline on the Positioner above it).

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { verifying } from "./retained-harness.js"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"
import { defineKeyframes, motion } from "../index"

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
          <div testId="text">measured text</div>
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
      <div testId="text">
        ab
        <span testId="span" style={style}>
          WWWW
        </span>
        cd
      </div>
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
          <div>
            <span style={{ color }}>WWWW</span>
          </div>
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

describeNative("a var() as the cursor of an inline box", () => {
  const cursors = (cursor: string, custom: Record<string, string>) => {
    let seen: string[] = []
    mounted(
      <div style={{ position: "absolute", left: 0, top: 0, width: 600, ...custom }}>
        <div testId="text" style={{ fontSize: 16, lineHeight: "20px" }}>
          <span style={{ cursor }}>WWWWWWWW</span>
        </div>
      </div>,
      (renderer) => {
        const [x, y] = box(renderer, "text")
        const at = (dx: number) => {
          renderer.nativeSimulateMouseMove(x + dx, y + 10)
          return renderer.getCursor()
        }
        seen = [at(8), at(500)]
      },
    )
    return seen
  }

  it("shows what the custom properties around the span say, as the literal does", () => {
    const literal = cursors("pointer", {})
    expect(literal).toEqual(["pointer", "default"])
    expect(cursors("var(--cursor)", { "--cursor": "pointer" })).toEqual(literal)
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

describeNative("a custom property set in a focus variant that applies", () => {
  const tabTo = (renderer: Renderer, testId: string) => {
    renderer.simulateKeystrokes("Tab")
    renderer.dispatchNativeEvents()
    renderer.flush()
    renderer.drawFrame()
    expect(renderer.matchesFocus(renderer.findByTestId(testId)!.id, ":focus-visible")).toBe(true)
  }

  /** What `read` sees before the element `testId` is focused, while it is, and after it is blurred. */
  const throughFocus = (tree: React.ReactElement, testId: string, read: (renderer: Renderer) => unknown) => {
    let seen: unknown[] = []
    mounted(tree, (renderer) => {
      renderer.drawFrame()
      const before = read(renderer)
      tabTo(renderer, testId)
      const during = read(renderer)
      renderer.blurElement(renderer.findByTestId(testId)!.id)
      renderer.flush()
      renderer.drawFrame()
      seen = [before, during, read(renderer)]
    })
    return seen
  }

  const page = (children: React.ReactNode) => (
    <div style={{ position: "absolute", left: 0, top: 0, width: 600, "--w": "40px" }}>{children}</div>
  )

  it("reaches the base style of the element, as a literal in the variant does", () => {
    const width = (renderer: Renderer) => box(renderer, "focusable")[2]
    const viaVar = throughFocus(
      page(<div testId="focusable" tabIndex={0} style={{ width: "var(--w)", height: 10, focusVisible: { "--w": "80px" } }} />),
      "focusable",
      width,
    )
    const literal = throughFocus(
      page(<div testId="focusable" tabIndex={0} style={{ width: 40, height: 10, focusVisible: { width: 80 } }} />),
      "focusable",
      width,
    )
    expect(literal).toEqual([40, 80, 40])
    expect(viaVar).toEqual(literal)
  }, SLOW)

  it("reaches a descendant of the element, and is gone from it once the element is blurred", () => {
    const width = (renderer: Renderer) => box(renderer, "child")[2]
    const seen = throughFocus(
      page(
        <div testId="focusable" tabIndex={0} style={{ width: 200, height: 20, focusVisible: { "--w": "80px" } }}>
          <div testId="child" style={{ width: "var(--w)", height: 10 }} />
        </div>,
      ),
      "focusable",
      width,
    )
    expect(seen).toEqual([40, 80, 40])
  }, SLOW)

  it("is read by the variants that apply together, whichever declares it", () => {
    const sizes = (renderer: Renderer) => box(renderer, "focusable").slice(2)
    const seen = throughFocus(
      page(
        <div
          testId="focusable"
          tabIndex={0}
          style={{
            width: "calc(var(--a, 1px) + var(--b, 2px))",
            height: 10,
            focusWithin: { "--a": "10px", height: "var(--b, 5px)" },
            focusVisible: { "--b": "20px" },
          }}
        />,
      ),
      "focusable",
      sizes,
    )
    expect(seen).toEqual([[3, 10], [30, 20], [3, 10]])
  }, SLOW)

  it("lets the variant that is laid over the other win", () => {
    const width = (renderer: Renderer) => box(renderer, "focusable")[2]
    const seen = throughFocus(
      page(
        <div
          testId="focusable"
          tabIndex={0}
          style={{ width: "var(--w)", height: 10, focusWithin: { "--w": "60px" }, focusVisible: { "--w": "80px" } }}
        />,
      ),
      "focusable",
      width,
    )
    expect(seen).toEqual([40, 80, 40])
  }, SLOW)

  it.each([
    ["focusVisible", "declares the custom property and reads it", { "--ring": "0 0 0 4px #ff0000", boxShadow: "var(--ring)" }],
    ["focusVisible", "only declares it, for the base to read", { "--ring": "0 0 0 4px #ff0000" }],
  ])("settles a transitioning box-shadow on the one the literal gives: %s that %s", (name, _, variant) => {
    const settled = (label: string, base: Record<string, unknown>, declared: Record<string, unknown>) =>
      paint(
        `focus-ring-transition-${label}`,
        <div style={{ position: "absolute", left: 0, top: 0, width: 600, height: 300 }}>
          <div
            tabIndex={0}
            testId="focusable"
            style={{
              position: "absolute",
              left: 20,
              top: 20,
              width: 40,
              height: 40,
              transition: "box-shadow 100ms linear",
              ...base,
              [name]: declared,
            }}
          />
        </div>,
        (renderer) => {
          renderer.clockPause()
          tabTo(renderer, "focusable")
          renderer.clockFastForward(500)
          renderer.dispatchNativeEvents()
        },
      )
    const base = "boxShadow" in variant ? {} : { boxShadow: "var(--ring)" }
    const viaVar = settled(`${name}-var-${Object.keys(variant).length}`, base, variant)
    const literal = settled(`${name}-literal-${Object.keys(variant).length}`, { boxShadow: "none" }, { boxShadow: "0 0 0 4px #ff0000" })
    for (const [x, y] of [[18, 40], [62, 40], [40, 18], [40, 62], [5, 5]] as const) {
      expectNear(viaVar.at(x, y), literal.at(x, y))
    }
    expectNear(viaVar.at(18, 40), RED)
  }, SLOW)

  it("paints a box-shadow of the base style the way a literal in the variant does", () => {
    const ring = (shadow: string, focusVisible: Record<string, unknown>) =>
      paint(
        `focus-ring-${shadow.replace(/\W/g, "")}`,
        <div style={{ position: "absolute", left: 0, top: 0, width: 600, height: 300 }}>
          <div
            tabIndex={0}
            testId="focusable"
            style={{ position: "absolute", left: 20, top: 20, width: 40, height: 40, boxShadow: shadow, focusVisible }}
          />
        </div>,
        (renderer) => tabTo(renderer, "focusable"),
      )
    const viaVar = ring("var(--ring)", { "--ring": "0 0 0 4px #ff0000" })
    const literal = ring("none", { boxShadow: "0 0 0 4px #ff0000" })
    for (const [x, y] of [[18, 40], [62, 40], [40, 18], [40, 62], [40, 40], [5, 5]] as const) {
      expectNear(viaVar.at(x, y), literal.at(x, y))
    }
    expectNear(viaVar.at(18, 40), RED)
  }, SLOW)
})

describeNative("a custom property set in focusWithin on an element that transitions or animates", () => {
  const focusedWidth = (host: Record<string, unknown>) => {
    let widths: number[] = []
    mounted(
      <div style={{ position: "absolute", left: 0, top: 0, width: 600, "--w": "40px", "--a": "none" }}>
        <div testId="host" style={{ height: 20, ...host }}>
          <div testId="inner" tabIndex={0} style={{ width: 10, height: 10 }} />
        </div>
      </div>,
      (renderer) => {
        renderer.clockPause()
        renderer.drawFrame()
        const before = box(renderer, "host")[2]
        renderer.simulateKeystrokes("Tab")
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.drawFrame()
        renderer.clockFastForward(2000)
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.drawFrame()
        widths = [before, box(renderer, "host")[2]]
      },
    )
    return widths
  }

  const cases: [string, Record<string, unknown>][] = [
    ["a transition of another property", { transition: "opacity 100ms" }],
    ["an animation that resolves to none", { animation: "var(--a)" }],
  ]

  for (const [name, motion] of cases) {
    it(`reaches the base style with ${name}, as it does without`, () => {
      const literal = focusedWidth({ width: 40, focusWithin: { width: 80 }, ...motion })
      expect(literal).toEqual([40, 80])
      expect(focusedWidth({ width: "var(--w)", focusWithin: { "--w": "80px" }, ...motion })).toEqual(literal)
      expect(focusedWidth({ width: 40, focusWithin: { "--v": "80px", width: "var(--v)" }, ...motion })).toEqual(literal)
    }, SLOW)
  }

  it("transitions the width a custom property of focusWithin changes", () => {
    expect(focusedWidth({ width: "var(--w)", transition: "width 100ms", focusWithin: { "--w": "80px" } })).toEqual([40, 80])
  }, SLOW)
})

describeNative("a var() declaration against the plain ones written around it", () => {
  const custom = { "--w": "4px", "--n": "none", "--p": "6px", "--line": "blue", "--b": "2px solid red", "--num": "8", "--s": "solid", "--c": "#ff0000" }

  const substituted = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/var\((--[\w-]+)\)/g, (_, name) => custom[name])
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, substituted(inner)]))
    }
    return value
  }

  /// The box of the element and of the child inside it, which says what the borders and padding add up to on each side.
  function measure(style: Record<string, unknown>, hovered: boolean) {
    let boxes: number[] = []
    mounted(
      <div style={{ position: "absolute", left: 0, top: 0, width: 400, height: 400, ...custom }}>
        <div testId="element" style={{ position: "absolute", left: 0, top: 0, ...style }}>
          <div testId="inner" style={{ width: 5, height: 5 }} />
        </div>
      </div>,
      (renderer) => {
        if (hovered) {
          renderer.nativeSimulateMouseMove(2, 2)
          renderer.flush()
          renderer.drawFrame()
        }
        boxes = [...box(renderer, "element"), ...box(renderer, "inner").slice(0, 2)]
      },
    )
    return boxes
  }

  const cases: [string, Record<string, unknown>][] = [
    ["a side shorthand after an all-sides width", { borderWidth: "var(--w)", borderStyle: "solid", borderTop: "1px solid" }],
    ["a side shorthand after an all-sides style", { borderStyle: "var(--n)", borderWidth: "2px", borderTop: "1px solid" }],
    ["borderBlock after an all-sides width", { borderWidth: "var(--w)", borderStyle: "solid", borderBlock: "1px solid" }],
    ["borderInline after an all-sides width", { borderWidth: "var(--w)", borderStyle: "solid", borderInline: "1px solid" }],
    ["a side shorthand after an all-sides color", { borderStyle: "solid", borderColor: "var(--line)", borderBottom: "10px solid #00ff00" }],
    ["a held side shorthand before an all-sides width", { borderTop: "var(--b)", borderWidth: 3 }],
    ["a held longhand before an invalid shorthand", { paddingTop: "var(--p)", padding: "1px bogus" }],
    ["a held border side before an invalid border", { borderStyle: "solid", borderTopWidth: "var(--w)", border: "1px wobbly 2px 3px" }],
    ["a held longhand before an invalid state shorthand", { paddingTop: "var(--p)", hover: { padding: "1px bogus" } }],
    ["a held longhand before a valid shorthand", { paddingTop: "var(--p)", padding: 2 }],
    ["a held shorthand before a longhand", { padding: "var(--p)", paddingLeft: 3 }],
    ["a bare number in a padding", { padding: "var(--num)" }],
    ["a bare number in a gap", { display: "flex", gap: "var(--num)" }],
    ["a state side shorthand over an all-sides width", { borderWidth: "var(--w)", borderStyle: "solid", hover: { borderTop: "1px solid" } }],
    ["a state borderInline over an all-sides width", { borderWidth: "var(--w)", borderStyle: "solid", hover: { borderInline: "1px solid" } }],
    ["a state all-sides color over a held side", { borderTop: "var(--b)", hover: { borderColor: "green" } }],
    ["a state longhand over a held shorthand", { padding: "var(--p)", hover: { paddingTop: 3 } }],
    [
      "a state side shorthand and its longhand over a held all-sides color",
      { borderColor: "var(--c)", borderStyle: "solid", borderWidth: 1, hover: { borderTop: "2px solid", borderTopWidth: "5px" } },
    ],
    [
      "a state borderInline and a side longhand over a held all-sides style",
      { borderWidth: 3, borderStyle: "var(--s)", hover: { borderInline: "2px solid", borderLeftWidth: "9px" } },
    ],
    [
      "a state side shorthand and its longhand over a held all-sides width",
      { borderWidth: "var(--w)", borderStyle: "solid", hover: { borderBottom: "2px solid", borderBottomWidth: "7px" } },
    ],
  ]

  for (const [name, style] of cases) {
    it(`gives the box of the literal values for ${name}`, () => {
      for (const hovered of "hover" in style ? [false, true] : [false]) {
        expect(measure(style, hovered), `${name}${hovered ? " (hover)" : ""}`).toEqual(measure(substituted(style), hovered))
      }
    }, SLOW)
  }

  it("keeps the longhand a state wrote after its side shorthand over a held all-sides border", () => {
    const hover = { borderTop: "2px solid", borderTopWidth: "5px" }
    expect(measure({ borderColor: "var(--c)", borderStyle: "solid", borderWidth: 1, hover }, true).slice(2, 4)).toEqual([5 + 2, 5 + 5 + 1])
  }, SLOW)

  it("drops a bare number from a length, as it does a plain one", () => {
    expect(measure({ padding: "var(--num)" }, false).slice(2, 4)).toEqual([5, 5])
    expect(measure({ padding: "8" }, false).slice(2, 4)).toEqual([5, 5])
  }, SLOW)

  it("keeps the longhand that the literal keeps", () => {
    expect(measure({ paddingTop: "var(--p)", padding: "1px bogus" }, false)[3]).toBe(5 + 6)
    expect(measure({ borderWidth: "var(--w)", borderStyle: "solid", borderTop: "1px solid" }, false).slice(2, 4)).toEqual([5 + 8, 5 + 1 + 4])
  }, SLOW)
})

describeNative("a var() that resolves to no motion", () => {
  /// How many elements 5 updates of an unrelated box build, with 20 cells that hold `cell` around it.
  const builtOver = (cell: Record<string, unknown>, span?: Record<string, unknown>) => {
    const root = createTestRoot({ width: 800, height: 600 })
    const renderer = root.renderer
    try {
      const tree = (n: number) => (
        <div style={{ position: "absolute", left: 0, top: 0, width: 600, "--a": "none", "--d": "200ms", "--t": "none", "--c": "#ff0000" }}>
          {Array.from({ length: 20 }, (_, i) => (
            <div key={i} style={{ padding: 2 }}>
              {span ? (
                <div>
                  row <span style={span}>span</span> tail
                </div>
              ) : (
                <div style={{ padding: 1 }}>
                  <div style={{ height: 5, width: 10, ...cell }} />
                </div>
              )}
            </div>
          ))}
          <div testId="other" style={{ width: n, height: 10, backgroundColor: "blue" }} />
        </div>
      )
      root.render(tree(10))
      renderer.flush()
      renderer.drawFrame()
      renderer.drawFrame()
      const before = renderer.getBuildCounters().elementsBuilt
      for (let i = 0; i < 5; i++) {
        root.render(tree(11 + i))
        renderer.flush()
        renderer.drawFrame()
      }
      return renderer.getBuildCounters().elementsBuilt - before
    } finally {
      root.unmount()
    }
  }

  it.each([
    ["animation", { animation: "var(--a)" }, { animation: "none" }],
    ["animationDuration", { animationDuration: "var(--d)" }, { animationDuration: "200ms" }],
    ["transition", { transition: "var(--t)" }, { transition: "none" }],
  ])("builds no more for a held %s than for the literal", (_, held, literal) => {
    const baseline = builtOver(literal)
    expect(baseline).toBe(builtOver({}))
    expect(builtOver(held)).toBe(baseline)
  }, SLOW)

  it.each([
    ["a transition", { color: "var(--c)", transition: "color 1s" }, { color: "#ff0000", transition: "color 1s" }],
    ["an animation", { color: "var(--c)", animation: "var(--a)" }, { color: "#ff0000", animation: "none" }],
  ])("builds no more for a span with %s and a var() than for the literal", (_, held, literal) => {
    const baseline = builtOver({}, literal)
    expect(builtOver({}, held)).toBe(baseline)
  }, SLOW)

  it("still runs an animation that a var() names", () => {
    defineKeyframes("var-grow", { from: { width: 100 }, to: { width: 200 } })
    mounted(
      <div style={{ position: "absolute", left: 0, top: 0, width: 600, "--a": "var-grow 1s linear infinite" }}>
        <div testId="slider" style={{ height: 10, width: 50, animation: "var(--a)" }} />
      </div>,
      (renderer) => {
        renderer.clockPause()
        renderer.drawFrame()
        renderer.clockFastForward(500)
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.drawFrame()
        expect(box(renderer, "slider")[2]).toBeCloseTo(150, 0)
      },
    )
  }, SLOW)
})

describeNative("a var() as the pointerEvents of an inline box", () => {
  const hits = (pointerEvents: string, custom: Record<string, string>) => {
    let count = 0
    mounted(
      <div style={{ position: "absolute", left: 0, top: 0, width: 600, ...custom }}>
        <div testId="text" style={{ fontSize: 16, lineHeight: "20px" }}>
          <span style={{ pointerEvents }} onPointerDown={() => count++}>
            WWWWWWWW
          </span>
        </div>
      </div>,
      (renderer) => {
        renderer.drawFrame()
        const bounds = box(renderer, "text")
        renderer.nativeSimulateClick(bounds[0] + 8, bounds[1] + 10)
        renderer.dispatchNativeEvents()
        renderer.flush()
      },
    )
    return count
  }

  it("keeps the pointer off the span, as the literal does", () => {
    expect(hits("auto", {})).toBe(1)
    expect(hits("none", {})).toBe(0)
    expect(hits("var(--pe)", { "--pe": "none" })).toBe(0)
    expect(hits("var(--pe)", { "--pe": "auto" })).toBe(1)
  }, SLOW)
})
