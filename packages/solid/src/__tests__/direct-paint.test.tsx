/**
 * A plain subtree can be drawn by one element that owns its nodes (`render/`, `setDirectPaint`) where each host would be a `Div`.
 * Each scene is mounted in a window of its own with the switch off and on and taken through commits that move text, style and size,
 * with a frame drawn again after each (which a retained root replays), and the pictures, the automation trees (without the boxes,
 * which a direct node does not record yet) and the painted text of every step are compared. The scenes hold roots that are direct
 * and, in the last, one that is not, which must be drawn as it always was.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSignal, type Accessor, type JSX } from "solid-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Scene = {
  name: string
  steps: number
  width?: number
  height?: number
  view: (step: Accessor<number>) => JSX.Element
  /** The roots the page has that are drawn direct. */
  directRoots: number
}

const CARD = {
  margin: "3px 6px",
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid #335577",
  backgroundColor: "#eef3f8",
  color: "#223344",
  fontSize: 14,
  lineHeight: "18px",
}

const scenes: Scene[] = [
  {
    name: "nested-boxes",
    steps: 4,
    width: 320,
    height: 260,
    directRoots: 2,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ margin: 8, padding: [4, 12, 20, 8][step()], border: "2px solid #223344", borderRadius: 10, backgroundColor: ["#ddeeff", "#ffeedd", "#ddeeff", "#eeffdd"][step()] }}>
          <div style={{ margin: "6px 10px", padding: 6, border: "1px dashed #884400", borderRadius: 4, backgroundColor: "#ffffff" }}>
            <div style={{ height: [20, 30, 20, 44][step()], margin: 4, backgroundColor: "#99bbdd", borderRadius: 3 }} />
            <div style={{ height: 12, marginTop: 6, borderTop: "3px solid #cc3300", backgroundColor: "#ccddee" }} />
          </div>
        </div>
        <div style={{ ...CARD, width: [200, 260, 200, 120][step()] }} />
      </div>
    ),
  },
  {
    name: "flex",
    steps: 4,
    width: 360,
    height: 260,
    directRoots: 2,
    view: (step) => (
      <div style={{ width: 340, backgroundColor: "#ffffff" }}>
        <div style={{ display: "flex", flexDirection: "row", gap: [4, 12, 4, 20][step()], padding: 6, backgroundColor: "#f4f4f4" }}>
          <div style={{ width: 60, height: 30, backgroundColor: "#cc4444" }} />
          <div style={{ flexGrow: 1, height: 30, backgroundColor: "#44cc44" }} />
          <div style={{ width: [40, 80, 40, 20][step()], height: 30, backgroundColor: "#4444cc" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10, padding: 6, alignItems: (["flex-start", "center", "flex-end", "stretch"] as const)[step()] }}>
          <div style={{ width: 80, height: 16, backgroundColor: "#cc8844" }} />
          <div style={{ width: 140, height: 16, backgroundColor: "#44cc88" }} />
          <div style={{ width: 60, height: 16, backgroundColor: "#8844cc" }} />
        </div>
      </div>
    ),
  },
  {
    name: "inherited-text",
    steps: 4,
    width: 360,
    height: 260,
    directRoots: 1,
    view: (step) => (
      <div style={{ width: 340, backgroundColor: "#ffffff" }}>
        <div style={{ fontSize: [16, 20, 16, 12][step()], fontWeight: [400, 700, 400, 600][step()], color: ["#aa2200", "#0044aa", "#aa2200", "#008844"][step()], padding: 8 }}>
          <text>{() => ["first line", "first line, longer", "first", "first line"][step()]}</text>
          <div style={{ marginTop: 4, padding: 4, backgroundColor: "#eef" }}>
            <text>inherits everything</text>
            <text style={{ color: "#000000", fontSize: 11 }}>{() => `own style ${step()}`}</text>
          </div>
          <text style={{ fontWeight: 400 }}>{"plain " + "weight"}</text>
        </div>
      </div>
    ),
  },
  {
    name: "em-units",
    steps: 4,
    width: 360,
    height: 220,
    directRoots: 2,
    view: (step) => (
      <div style={{ backgroundColor: "#ffffff", width: 340 }}>
        <div style={{ fontSize: [12, 20, 12, 28][step()], color: "#aa2200", display: "flex" }}>
          {[0, 1, 2].map((index) => (
            <div style={{ width: "2em", height: "1.2em", margin: "0 0.5em", borderLeft: "0.25em solid currentColor", backgroundColor: "currentColor", borderRadius: "0.3em" }}>
              <text style={{ fontSize: "0.5em", color: "#ffffff" }}>{`${index}`}</text>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 16, padding: "0.5em 1em", margin: "0.25rem" }}>
          <div style={{ width: ["10em", "12em", "10em", "5em"][step()], height: "2em", backgroundColor: "#99bbdd" }} />
        </div>
      </div>
    ),
  },
  {
    name: "nowrap-ellipsis",
    steps: 3,
    width: 320,
    height: 220,
    directRoots: 3,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ width: [120, 90, 200][step()], margin: 4 }}>
          <text style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", fontSize: 14, color: "#223344" }}>{() => ["a long line that does not fit in its box", "short", "another long line that does not fit in its box either"][step()]}</text>
        </div>
        <div style={{ width: 100, margin: 4 }}>
          <text style={{ whiteSpace: "nowrap", fontSize: 14 }}>nowrap with no ellipsis, longer than the box</text>
        </div>
        <div style={{ width: 100, margin: 4, backgroundColor: "#f4f4f4" }}>
          <text style={{ fontSize: 14 }}>wrapping text in a narrow box wraps on its words</text>
        </div>
      </div>
    ),
  },
  {
    name: "inline-spans",
    steps: 3,
    width: 320,
    height: 200,
    directRoots: 2,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ ...CARD }}>
          <text>
            Hello <span style={{ color: ["#cc0000", "#0000cc", "#cc0000"][step()], fontWeight: 700 }}>big <span style={{ backgroundColor: "#ffff00" }}>{["world", "there", "world"][step()]}</span></span>!
          </text>
        </div>
        <text style={{ ...CARD, whiteSpace: "nowrap", textOverflow: "ellipsis", width: [100, 160, 100][step()] }}>a text host that is a root of its own</text>
      </div>
    ),
  },
  {
    name: "ineligible",
    steps: 3,
    width: 320,
    height: 300,
    directRoots: 0,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ ...CARD, overflow: "hidden", height: 20 }} />
        <div style={{ ...CARD, position: "relative", height: 20 }}>
          <div style={{ position: "absolute", top: [2, 6, 10][step()], right: 4, width: 20, height: 12, backgroundColor: "#cc4444" }} />
        </div>
        <div style={{ ...CARD, opacity: [1, 0.5, 1][step()], height: 20 }} />
        <div style={{ ...CARD, height: 20 }} onClick={() => {}} />
        <div style={{ ...CARD, height: 20 }} tabIndex={0} />
        <div style={{ ...CARD, height: 20, cursor: "pointer" }} />
        <div style={{ ...CARD, height: 20, transform: ["rotate(0deg)", "rotate(2deg)", "rotate(0deg)"][step()] }} />
        <div style={{ ...CARD, height: 20, overflow: "auto" }} />
      </div>
    ),
  },
  {
    name: "ineligible-next-to-eligible",
    steps: 3,
    width: 320,
    height: 300,
    // The page root is a context of its own, and so is the clipped box: the plain boxes around it are direct.
    directRoots: 3,
    view: (step) => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }}>
        <div style={{ ...CARD, backgroundColor: ["#eef3f8", "#ffeedd", "#eef3f8"][step()] }}>
          <text>{() => `plain ${step()}`}</text>
        </div>
        <div style={{ ...CARD, overflow: "hidden", height: 40 }}>
          <text>clipped, so a scroller</text>
          <div style={{ height: 80, backgroundColor: "#99bbdd" }} />
        </div>
        <div style={{ ...CARD, position: "relative" }}>
          <div style={{ position: "absolute", top: [2, 6, 10][step()], right: 4, width: 20, height: 12, backgroundColor: "#cc4444" }} />
          <text>positioned child</text>
        </div>
        <div style={{ ...CARD, opacity: [1, 0.5, 1][step()] }}>
          <text>faded</text>
        </div>
        <div style={{ ...CARD }}>
          <div style={{ padding: 4, backgroundColor: "#ddd" }}>
            <text>nested plain</text>
          </div>
        </div>
      </div>
    ),
  },
]

let shots: string

beforeAll(() => {
  // DIRECT_PAINT_SHOTS keeps the pictures to look at.
  shots = process.env.DIRECT_PAINT_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), "direct-paint-"))
  fs.mkdirSync(shots, { recursive: true })
})

afterAll(() => {
  // The switch is process wide: leave it as the run found it.
  const root = createTestRoot()
  root.renderer.setDirectPaint(process.env.GPUIX_DIRECT_PAINT === "1")
  root.unmount()
  if (process.env.DIRECT_PAINT_SHOTS === undefined) fs.rmSync(shots, { recursive: true, force: true })
})

/** The automation tree as JSON, without the boxes. */
function structure(tree: string) {
  return JSON.parse(tree, (key, value) => (key === "bounds" ? undefined : value))
}

function run(scene: Scene, direct: boolean) {
  const app = createTestRoot({ width: scene.width ?? 400, height: scene.height ?? 300 })
  const renderer = app.renderer
  renderer.setDirectPaint(direct)
  renderer.clockPause()
  try {
    const [step, setStep] = createSignal(0)
    app.render(() => scene.view(step))
    renderer.resetBuildCounters()
    const frames = []
    for (let index = 0; index < scene.steps; index++) {
      if (index > 0) app.flushSync(() => setStep(index))
      renderer.dispatchNativeEvents()
      renderer.flush()
      // Direct paint is off while a screen reader is connected, which a test window pretends.
      renderer.setA11yActive(false)
      for (const frame of ["changed", "again"]) {
        renderer.drawFrame()
        const file = path.join(shots, `${scene.name}-${index}-${frame}-${direct ? "on" : "off"}.png`)
        renderer.captureScreenshot(file)
        frames.push({ label: `step ${index}, ${frame}`, picture: fs.readFileSync(file), painted: renderer.getPaintedText(), tree: structure(renderer.getAutomationTree()) })
      }
    }
    const counters = renderer.getBuildCounters()
    const retained = renderer.getRetainedCounters()
    return {
      frames,
      roots: counters.directRoots,
      nodes: counters.directNodes,
      hits: retained.hits,
      mismatches: renderer.getRetainMismatches(),
    }
  } finally {
    app.unmount()
  }
}

describeNative("direct paint", { timeout: 120_000 }, () => {
  for (const scene of scenes) {
    it(`draws ${scene.name} as the Divs do`, () => {
      const off = run(scene, false)
      const on = run(scene, true)
      expect(off.roots, "nothing is direct with the switch off").toBe(0)
      if (scene.directRoots === 0) expect(on.roots, "nothing here is plain").toBe(0)
      else expect(on.roots, "the plain roots are drawn direct").toBeGreaterThanOrEqual(scene.directRoots)
      expect(on.nodes, "a direct root holds its nodes").toBeGreaterThanOrEqual(on.roots)
      expect(on.mismatches, "what a retained root replays is what is built").toEqual([])
      for (let index = 0; index < off.frames.length; index++) {
        const frame = off.frames[index].label
        expect(Buffer.compare(on.frames[index].picture, off.frames[index].picture), `the picture of ${frame}`).toBe(0)
        expect(on.frames[index].painted, `the painted text of ${frame}`).toEqual(off.frames[index].painted)
        expect(on.frames[index].tree, `the automation tree of ${frame}`).toEqual(off.frames[index].tree)
      }
    })
  }
})
