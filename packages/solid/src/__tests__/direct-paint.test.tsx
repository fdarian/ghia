/**
 * A plain subtree can be drawn by one element that owns its nodes (`render/`, `setDirectPaint`) where each host would be a `Div`.
 * Each scene is mounted in a window of its own with the switch off and on and taken through commits that move text, style and size,
 * with a frame drawn again after each (which a retained root replays), and the pictures, the automation trees (with the boxes a
 * direct node records as a `Div` does) and the painted text of every step are compared. The scenes hold roots that are direct
 * and, in the last, one that is not, which must be drawn as it always was. The last scene has the pointer cross a root that
 * holds nodes with a cursor and with `pointer-events`, and compares the target, the path of the event and the cursor.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSignal, type Accessor, type JSX } from "solid-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { HostElement } from "../index.js"
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
        <div style={{ ...CARD, height: 20, userSelect: "none" }} />
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
        frames.push({ label: `step ${index}, ${frame}`, picture: fs.readFileSync(file), painted: renderer.getPaintedText(), tree: JSON.parse(renderer.getAutomationTree()) })
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

  it("has the pointer cross the nodes of a root as it crosses Divs", () => {
    const run = (direct: boolean) => {
      const app = createTestRoot({ width: 320, height: 240 })
      const renderer = app.renderer
      renderer.setDirectPaint(direct)
      renderer.clockPause()
      renderer.resetBuildCounters()
      const hosts: Record<string, HostElement> = {}
      const named = (name: string) => (host: HostElement) => void (hosts[name] = host)
      const nameOf = (target: unknown) => Object.keys(hosts).find((name) => hosts[name] === target) ?? String(target)
      const heard: string[] = []
      try {
        app.render(() => (
          <div
            ref={named("page")}
            style={{ width: 300, height: 220, backgroundColor: "#ffffff" }}
            onPointerMove={(event) => heard.push(`${nameOf(event.target)} < ${event.composedPath().map(nameOf).join(" < ")}`)}
          >
            <div ref={named("a")} style={{ ...CARD, margin: 10, width: 200, padding: 0, cursor: "text" }}>
              <div ref={named("a1")} style={{ width: 80, height: 40, backgroundColor: "#99bbdd", cursor: "pointer" }} />
              <div ref={named("a2")} style={{ width: 80, height: 40, backgroundColor: "#ddbb99", pointerEvents: "none" }}>
                <div ref={named("a2x")} style={{ width: 30, height: 30, backgroundColor: "#bbdd99", pointerEvents: "auto", cursor: "grab" }} />
              </div>
              <div ref={named("a3")} style={{ width: 80, height: 20, backgroundColor: "#dd99bb" }}>
                <text ref={named("a3t")} style={{ fontSize: 11 }}>label</text>
              </div>
            </div>
          </div>
        ))
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.setA11yActive(false)
        renderer.drawFrame()
        const crossings = [
          [10, 20],
          [20, 30],
          [30, 60],
          [60, 70],
          [60, 100],
          [150, 20],
          [250, 20],
          [400, 400],
        ].map(([x, y]) => {
          renderer.nativeSimulateMouseMove(x, y)
          renderer.drawFrame()
          return { x, y, heard: heard.splice(0), cursor: renderer.getCursor() }
        })
        const boxes = Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, host.getBoundingClientRect()]))
        return { crossings, boxes, roots: renderer.getBuildCounters().directRoots }
      } finally {
        app.unmount()
      }
    }
    const off = run(false)
    const on = run(true)
    expect(off.roots).toBe(0)
    expect(on.roots, "the card is a root of its own").toBeGreaterThanOrEqual(1)
    expect(on.crossings).toEqual(off.crossings)
    expect(on.boxes).toEqual(off.boxes)
    expect(on.crossings.map((crossing) => crossing.heard)).toEqual([
      ["a < a < page"],
      ["a1 < a1 < a < page"],
      ["a2x < a2x < a2 < a < page"],
      ["a < a < page"],
      ["a3t < a3t < a3 < a < page"],
      ["a < a < page"],
      ["page < page"],
      [],
    ])
    expect(on.crossings.map((crossing) => crossing.cursor)).toEqual(["text", "pointer", "grab", "text", "text", "text", "default", "default"])
  })
})
