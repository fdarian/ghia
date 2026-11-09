// @ts-nocheck
/**
 * The step that applies a declared style to a host element (`apply_styles`) is kept for the next element of the same style
 * (`css/style_cache.rs`), keyed by the style's `Arc`, the element's colour context and its length context. Each scene is mounted in a
 * window of its own with the cache off, on, and verifying (which runs the step for every element it found kept and panics when the
 * two differ), through the changes that move what the step reads (a hover, a focus, a theme, a font size, a container's width, a
 * custom property, a direction, a transition), and the pictures, the boxes, the automation tree and the painted text of every
 * step are compared.
 */

import fs from "node:fs"
import path from "node:path"
import React from "react"
import { afterAll, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Scene = {
  name: string
  /** The page of step `step`; the first is mounted, the next ones are rendered over it. */
  page: (step: number) => React.ReactElement
  /** Runs after the page of `step` is on screen, before it is read. */
  act?: (renderer: any, step: number) => void
  steps: number
  width?: number
  height?: number
  /** The scene has elements that share a style, so the cache must have replayed some step. */
  shares?: boolean
}

const CARD = {
  height: 22,
  margin: "3px 6px",
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid #335577",
  boxShadow: "0 1px 3px rgba(0,0,0,.35)",
  backgroundColor: "#eef3f8",
  color: "#223344",
  fontSize: 14,
  lineHeight: "18px",
}

const scenes: Scene[] = [
  {
    name: "rows-hover",
    steps: 4,
    shares: true,
    width: 320,
    height: 260,
    page: () => (
      <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} style={{ ...CARD, hover: { backgroundColor: "#ffddaa", borderColor: "#aa5500" } }}>
            <text style={{ fontSize: 13, color: "#112233" }}>{`row ${index}`}</text>
          </div>
        ))}
      </div>
    ),
    act: (renderer, step) => {
      const y = [0, 40, 100, 400][step]
      renderer.nativeSimulateMouseMove(40, y)
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "contexts",
    steps: 4,
    shares: true,
    width: 360,
    height: 260,
    page: (step) => {
      const child = (key: string) => (
        <div
          key={key}
          style={{
            width: "2em",
            height: "1.2em",
            margin: "0 0.5em",
            borderLeft: "0.25em solid currentColor",
            backgroundColor: "currentColor",
            boxShadow: "0.1em 0.1em 0.2em currentColor",
            borderRadius: "0.3em",
          }}
        />
      )
      const sizes = [12, 20, 12, 28]
      const colors = ["#aa2200", "#0044aa", "#aa2200", "#008844"]
      return (
        <div style={{ backgroundColor: "#ffffff", width: 340 }}>
          <div style={{ fontSize: sizes[step], color: "#aa2200", display: "flex" }}>{[0, 1, 2].map((i) => child(`a${i}`))}</div>
          <div style={{ fontSize: 20, color: colors[step], display: "flex" }}>{[0, 1, 2].map((i) => child(`b${i}`))}</div>
          <div style={{ fontSize: 12, color: "#aa2200", display: "flex" }}>{[0, 1, 2].map((i) => child(`c${i}`))}</div>
          <div style={{ display: "flex" }}>{[0, 1, 2].map((i) => child(`d${i}`))}</div>
        </div>
      )
    },
  },
  {
    name: "appearance",
    steps: 4,
    shares: true,
    width: 320,
    height: 200,
    page: () => (
      <div style={{ colorScheme: "light dark", width: 300, padding: 8, backgroundColor: "light-dark(#ffffff, #101820)", color: "light-dark(#102030, #e0f0ff)" }}>
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            style={{
              height: 24,
              margin: 4,
              backgroundColor: "light-dark(#dde8f4, #223a52)",
              border: "2px solid currentColor",
              boxShadow: "0 2px 4px light-dark(rgba(0,0,0,.3), rgba(255,255,255,.2))",
            }}
          />
        ))}
      </div>
    ),
    act: (renderer, step) => {
      renderer.setAppearance(["light", "dark", "light", "dark"][step])
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "container-queries",
    steps: 4,
    shares: true,
    width: 700,
    height: 260,
    page: (step) => {
      const wide = [200, 520, 200, 380][step]
      const item = (key: number) => (
        <div
          key={key}
          style={{
            height: 20,
            margin: 4,
            backgroundColor: "#99bbdd",
            width: "50cqw",
            "@container": { "(min-width: 300px)": { backgroundColor: "#dd9966", width: "30cqw", borderRadius: 8 } },
          }}
        />
      )
      return (
        <div style={{ backgroundColor: "#ffffff" }}>
          <div style={{ containerType: "inline-size", width: wide }}>{[0, 1, 2].map(item)}</div>
          <div style={{ containerType: "inline-size", width: 240 }}>{[3, 4, 5].map(item)}</div>
        </div>
      )
    },
    act: (renderer, step) => {
      renderer.setWindowSize([700, 600, 700, 500][step], 260)
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "var",
    steps: 4,
    shares: true,
    width: 320,
    height: 220,
    page: (step) => {
      const colors = ["#cc2200", "#22aa44", "#cc2200", "#2244cc"]
      const shifts = ["10px", "40px", "10px", "70px"]
      const child = (key: string) => (
        <div
          key={key}
          style={{ width: 40, height: 18, margin: 4, backgroundColor: "var(--tone)", translate: "var(--shift) 0", border: "1px solid var(--tone)" }}
        />
      )
      return (
        <div style={{ backgroundColor: "#ffffff" }}>
          <div style={{ "--tone": colors[step], "--shift": shifts[step] }}>{[0, 1, 2].map((i) => child(`a${i}`))}</div>
          <div style={{ "--tone": "#444444", "--shift": "0px" }}>{[0, 1, 2].map((i) => child(`b${i}`))}</div>
        </div>
      )
    },
  },
  {
    name: "rtl",
    steps: 4,
    shares: true,
    width: 320,
    height: 220,
    page: (step) => {
      const direction = ["ltr", "rtl", "ltr", "rtl"][step]
      const child = (key: string) => (
        <div
          key={key}
          style={{
            width: 120,
            height: 20,
            marginInlineStart: 30,
            paddingInlineEnd: 10,
            borderInlineStart: "6px solid #aa3300",
            backgroundColor: "#ccddee",
            textAlign: "start",
          }}
        >
          <text style={{ fontSize: 13, color: "#000000" }}>{key}</text>
        </div>
      )
      return (
        <div style={{ backgroundColor: "#ffffff", width: 300 }}>
          <div style={{ direction }}>{[0, 1, 2].map((i) => child(`a${i}`))}</div>
          <div style={{ direction: "ltr" }}>{[0, 1, 2].map((i) => child(`b${i}`))}</div>
        </div>
      )
    },
  },
  {
    name: "transition",
    steps: 5,
    shares: true,
    width: 320,
    height: 220,
    page: (step) => {
      const wide = step >= 1 && step < 4
      return (
        <div style={{ backgroundColor: "#ffffff" }}>
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              style={{
                height: 20,
                margin: 4,
                width: index < 3 && wide ? 260 : 100,
                backgroundColor: index < 3 && wide ? "#dd8844" : "#4488dd",
                transition: "width 1s linear, background-color 1s linear",
              }}
            />
          ))}
        </div>
      )
    },
    act: (renderer, step) => {
      renderer.clockFastForward(step === 0 ? 0 : 300)
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "focus",
    steps: 4,
    shares: true,
    width: 320,
    height: 220,
    page: () => (
      <div style={{ backgroundColor: "#ffffff", width: 300 }}>
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            testId={`f${index}`}
            tabIndex={0}
            style={{
              ...CARD,
              focusVisible: { outline: "2px solid #ff0066", outlineOffset: 1 },
              focusWithin: { backgroundColor: "#ffeecc" },
            }}
          />
        ))}
      </div>
    ),
    act: (renderer, step) => {
      const target = [null, "f1", "f3", null][step]
      if (target) renderer.focusElement(renderer.findByTestId(target).id)
      else renderer.blurElement?.(renderer.findByTestId("f3").id)
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "inert-and-pointer-events",
    steps: 2,
    shares: true,
    width: 320,
    height: 160,
    page: (step) => (
      <div style={{ backgroundColor: "#ffffff", width: 300 }}>
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} inert={step === 1 && index % 2 === 0} style={{ ...CARD, pointerEvents: index % 2 ? "none" : "auto", hover: { backgroundColor: "#ffddaa" } }} />
        ))}
      </div>
    ),
    act: (renderer) => {
      renderer.nativeSimulateMouseMove(40, 30)
      renderer.dispatchNativeEvents()
    },
  },
]

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  const walk = (node) => {
    out[`${node.type}#${node.id}`] = renderer.getElementBounds(node.id)
    for (const child of node.children ?? []) walk(child)
  }
  walk(renderer.toJSON())
  return out
}

function run(scene: Scene, mode: "off" | "on" | "verify") {
  const root = createTestRoot({ width: scene.width ?? 400, height: scene.height ?? 300 })
  const renderer = root.renderer
  renderer.setStyleCache(mode)
  renderer.clockPause()
  try {
    const frames = []
    renderer.resetBuildCounters()
    for (let step = 0; step < scene.steps; step++) {
      root.render(scene.page(step))
      renderer.dispatchNativeEvents()
      renderer.flush()
      renderer.setA11yActive(false)
      renderer.drawFrame()
      scene.act?.(renderer, step)
      renderer.drawFrame()
      const file = path.join(SHOTS_DIR, `style-cache-${scene.name}-${step}-${mode}.png`)
      renderer.captureScreenshot(file)
      frames.push({
        picture: fs.readFileSync(file),
        boxes: boxes(renderer),
        painted: renderer.getPaintedText(),
        tree: renderer.getAutomationTree(),
      })
    }
    const counters = renderer.getBuildCounters()
    return { frames, replayed: counters.styleAppliesReplayed, computed: counters.styleAppliesComputed }
  } finally {
    root.unmount()
    renderer.setStyleCache(process.env.GPUIX_STYLE_CACHE_OFF !== undefined ? "off" : process.env.GPUIX_RETAIN_VERIFY !== undefined ? "verify" : "on")
  }
}

describeNative("the style cache", { timeout: 120_000 }, () => {
  afterAll(() => {
    // The switch is process wide: leave it as the run found it.
    const root = createTestRoot()
    root.renderer.setStyleCache(process.env.GPUIX_STYLE_CACHE_OFF !== undefined ? "off" : process.env.GPUIX_RETAIN_VERIFY !== undefined ? "verify" : "on")
    root.unmount()
  })

  for (const scene of scenes) {
    it(`draws ${scene.name} as the step run every time does`, () => {
      const off = run(scene, "off")
      const on = run(scene, "on")
      const verified = run(scene, "verify")
      expect(off.replayed, "an off cache replays nothing").toBe(0)
      if (scene.shares) {
        expect(on.replayed, "elements that share a style replay it").toBeGreaterThan(0)
        expect(verified.replayed, "verifying still finds styles kept").toBeGreaterThan(0)
      }
      for (const other of [on, verified]) {
        for (let step = 0; step < scene.steps; step++) {
          expect(Buffer.compare(other.frames[step].picture, off.frames[step].picture), `the picture of step ${step}`).toBe(0)
          expect(other.frames[step].boxes, `the boxes of step ${step}`).toEqual(off.frames[step].boxes)
          expect(other.frames[step].painted, `the painted text of step ${step}`).toEqual(off.frames[step].painted)
          expect(other.frames[step].tree, `the automation tree of step ${step}`).toEqual(off.frames[step].tree)
        }
      }
    })
  }

  it("applies the style of a virtual-list row root from the cache, and clones no style to say the row does not lift", () => {
    const root = createTestRoot({ width: 320, height: 260 })
    const renderer = root.renderer
    renderer.setStyleCache("on")
    renderer.clockPause()
    try {
      renderer.resetBuildCounters()
      root.render(
        <virtual-list overdraw={0} estimatedItemHeight={30} style={{ width: 300, height: 240 }}>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} style={{ ...CARD, position: "relative", zIndex: 2 }}>
              <text style={{ fontSize: 13, color: "#112233" }}>{`row ${index}`}</text>
            </div>
          ))}
        </virtual-list>,
      )
      renderer.dispatchNativeEvents()
      renderer.flush()
      renderer.setA11yActive(false)
      renderer.drawFrame()
      const counters = renderer.getBuildCounters()
      expect(counters.styleDescClones, "no StyleDesc is cloned to build a row").toBe(0)
      expect(counters.styleAppliesReplayed, "the rows share the style of the first").toBeGreaterThan(counters.styleAppliesComputed)
      expect(counters.styleAppliesComputed, "the row root and its text, once each").toBeLessThanOrEqual(4)
    } finally {
      root.unmount()
    }
  })
})
