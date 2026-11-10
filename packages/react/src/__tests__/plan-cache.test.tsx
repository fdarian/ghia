// @ts-nocheck
/**
 * The children plan of a host element (`text/plan_cache.rs`) is kept on the element for the next build, keyed by the revision of
 * its subtree, the `white-space` it inherits and the `display` and `order` that `@container` blocks gave. Each scene is mounted in a
 * window of its own with the cache off, on, and verifying (which plans again every plan it found kept and panics when the two
 * differ), through the changes that move what the plan reads, and the pictures, the boxes, the automation tree, the accessibility
 * tree and the painted text of every step are compared.
 */

import fs from "node:fs"
import path from "node:path"
import React from "react"
import { afterAll, describe, expect, it } from "vitest"
import { encodeWireBatchForTest } from "@ghia/native/testing"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Scene = {
  name: string
  page: (step: number) => React.ReactElement
  /** Runs after the page of `step` is on screen, before it is read. */
  act?: (renderer: any, step: number) => void
  steps: number
  width?: number
  height?: number
  a11y?: boolean
}

const TEXT = { fontSize: 14, lineHeight: "18px", color: "#223344" } as const
const BOX = { margin: 4, padding: 4, backgroundColor: "#dde8f4" } as const

const scenes: Scene[] = [
  {
    name: "white-space-of-an-ancestor",
    steps: 6,
    page: (step) => {
      const whiteSpace = ["normal", "pre", "pre-wrap", "nowrap", "pre-line", "normal"][step]
      return (
        <div style={{ width: 300, backgroundColor: "#ffffff", whiteSpace, ...TEXT }}>
          <div style={BOX}>{"a   b\n  c  d"}</div>
          <div style={BOX}>
            <div>{"  x   y  "}</div>
            <span style={{ fontWeight: "bold" }}>{"  bold   words \n next"}</span>
            {"  tail   text  "}
          </div>
          <div style={{ ...BOX, whiteSpace: step % 2 ? "normal" : "pre" }}>{"declared   here\n and   kept"}</div>
          <div style={BOX}>
            <span style={{ whiteSpace: "pre" }}>{"  inner   pre  "}</span>
            {" after   it "}
          </div>
        </div>
      )
    },
  },
  {
    name: "display-and-order-of-children",
    steps: 6,
    width: 360,
    height: 320,
    page: (step) => {
      const orders = [[0, 0, 0, 0], [3, 2, 1, 0], [-1, 0, 5, 2], [0, 0, 0, 0], [2, 2, 1, 1], [1, 0, 0, -3]][step]
      const displays = ["block", "none", "inline", "inline-block", "contents", "block"][step]
      return (
        <div style={{ width: 340, backgroundColor: "#ffffff", ...TEXT }}>
          <div style={{ display: "flex", flexDirection: "row", ...BOX }}>
            {orders.map((order, index) => (
              <div key={index} style={{ order, width: 50, backgroundColor: "#ccddee" }}>{`item ${index}`}</div>
            ))}
          </div>
          <div style={{ display: step % 2 ? "grid" : "flex", gridTemplateColumns: "1fr 1fr", ...BOX }}>
            {orders.map((order, index) => (
              <div key={index} style={{ order }}>{`cell ${index}`}</div>
            ))}
          </div>
          <div style={BOX}>
            {"before "}
            <div style={{ display: displays, backgroundColor: "#ffdd99" }}>{"toggled"}</div>
            {" between "}
            <span style={{ display: displays === "contents" ? "inline" : displays }}>{"span"}</span>
            {" after"}
          </div>
        </div>
      )
    },
  },
  {
    name: "inserted-removed-and-reordered-children",
    steps: 7,
    width: 360,
    height: 260,
    page: (step) => {
      const pieces = [
        ["a ", "b ", "c"],
        ["a ", "new ", "b ", "c"],
        ["a ", "b ", "c", " end"],
        ["c", "b ", "a "],
        ["c"],
        [],
        ["x ", "y "],
      ][step]
      const spans = [["s1", "s2"], ["s1", "s2", "s3"], ["s3", "s1"], ["s2", "s1", "s3"], [], ["s1"], ["s2", "s1"]][step]
      return (
        <div style={{ width: 340, backgroundColor: "#ffffff", ...TEXT }}>
          <div style={BOX}>
            {pieces.map((piece) => (
              <React.Fragment key={piece}>{piece}</React.Fragment>
            ))}
          </div>
          <div style={BOX}>
            {spans.map((id) => (
              <span key={id} style={{ fontWeight: id === "s2" ? "bold" : "normal", color: id === "s3" ? "#aa2200" : "#223344" }}>{`${id} `}</span>
            ))}
            {step % 3 === 0 ? <div style={{ display: "inline-block", width: 20, height: 12, backgroundColor: "#4488dd" }} /> : null}
            {step % 2 === 0 ? "tail" : null}
          </div>
          <div style={BOX}>
            {spans.map((id) => (
              <div key={id} style={{ height: 14, backgroundColor: "#99bbdd" }}>{id}</div>
            ))}
            {pieces.map((piece) => `${piece}`)}
          </div>
        </div>
      )
    },
  },
  {
    name: "a-child-between-text-and-element",
    steps: 6,
    width: 360,
    height: 240,
    page: (step) => {
      const child = [
        "just text ",
        <span key="k" style={{ color: "#aa2200" }}>{"a span "}</span>,
        <div key="k" style={{ backgroundColor: "#ffdd99" }}>{"a block"}</div>,
        <div key="k">{"a text "}</div>,
        "back to text ",
        <div key="k" style={{ display: "inline-block", width: 24, height: 12, backgroundColor: "#4488dd" }} />,
      ][step]
      return (
        <div style={{ width: 340, backgroundColor: "#ffffff", ...TEXT }}>
          <div style={BOX}>
            {"first "}
            {child}
            {" last"}
          </div>
          <div style={BOX}>
            {"lead "}
            {child}
          </div>
          <div style={{ display: "flex", ...BOX }}>
            {child}
            {"and "}
          </div>
        </div>
      )
    },
  },
  {
    name: "display-contents-splices",
    steps: 5,
    width: 360,
    height: 240,
    page: (step) => (
      <div style={{ width: 340, backgroundColor: "#ffffff", whiteSpace: step % 2 ? "pre" : "normal", ...TEXT }}>
        <div style={BOX}>
          {"outer  "}
          <div style={{ display: step < 4 ? "contents" : "block", whiteSpace: step === 2 ? "pre-wrap" : undefined }}>
            {"inside   contents "}
            <span>{"span "}</span>
            {step >= 1 ? <div style={{ display: "contents" }}>{" nested   "}</div> : null}
          </div>
          {"  end"}
        </div>
      </div>
    ),
  },
  {
    name: "container-query-display",
    steps: 4,
    width: 700,
    height: 260,
    page: (step) => (
      <div style={{ backgroundColor: "#ffffff", containerType: "inline-size", width: "100%", ...TEXT }}>
        <div style={BOX}>
          {"lead "}
          <div style={{ "@container": { "(min-width: 500px)": { display: "inline" } }, backgroundColor: "#ffdd99" }}>{`wide ${step} `}</div>
          {"trail "}
          <span style={{ "@container": { "(min-width: 500px)": { display: "none" } } }}>{"narrow only"}</span>
        </div>
        <div style={{ display: "flex", ...BOX }}>
          {[0, 1, 2].map((index) => (
            <div key={index} style={{ "@container": { "(min-width: 500px)": { order: 3 - index } } }}>{`flex ${index}`}</div>
          ))}
        </div>
      </div>
    ),
    act: (renderer, step) => {
      renderer.setWindowSize([700, 400, 700, 450][step], 260)
      renderer.dispatchNativeEvents()
    },
  },
  {
    name: "tables",
    steps: 5,
    width: 360,
    height: 260,
    page: (step) => (
      <div style={{ width: 340, backgroundColor: "#ffffff", ...TEXT }}>
        <div style={{ display: "table", ...BOX }}>
          {step % 2 === 0 ? "loose text " : null}
          <div style={{ display: "table-row" }}>
            <div style={{ display: "table-cell", padding: 2 }}>{"cell a"}</div>
            <div style={{ display: step === 3 ? "block" : "table-cell", padding: 2 }}>{"cell b"}</div>
            {step >= 1 ? "  row text  " : null}
          </div>
          {step >= 2 ? <div style={{ display: "table-cell" }}>{"orphan cell"}</div> : null}
        </div>
        <div style={BOX}>
          <div style={{ display: "table-cell" }}>{"loose part"}</div>
          {step >= 1 ? <div style={{ display: "table-row" }}>{"loose row"}</div> : null}
        </div>
      </div>
    ),
  },
  {
    name: "read-out-text",
    steps: 5,
    a11y: true,
    width: 360,
    height: 200,
    page: (step) => (
      <div style={{ width: 340, backgroundColor: "#ffffff", ...TEXT }}>
        <div testId="read">
          {["Hello ", "Hello, ", "Hello, "][Math.min(step, 2)]}
          <span>{["world", "world", "there"][Math.min(step, 2)]}</span>
          {step >= 3 ? <div style={{ display: "inline-block" }}>{"atomic"}</div> : null}
        </div>
        <div aria-valuetext="given">{`given ${step}`}</div>
        <div>
          {step === 4 ? <div>{"block"}</div> : null}
          {"always"}
        </div>
      </div>
    ),
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

/** The tree names the frame it was read in and the time. */
function withoutFrame(tree) {
  const { frame, ...rest } = typeof tree === "string" ? JSON.parse(tree) : tree
  return rest
}

const defaultMode = () => (process.env.GPUIX_STYLE_CACHE_OFF !== undefined ? "off" : process.env.GPUIX_RETAIN_VERIFY !== undefined ? "verify" : "on")

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
      renderer.setA11yActive(scene.a11y === true)
      renderer.drawFrame()
      scene.act?.(renderer, step)
      renderer.drawFrame()
      const file = path.join(SHOTS_DIR, `plan-cache-${scene.name}-${step}-${mode}.png`)
      renderer.captureScreenshot(file)
      frames.push({
        picture: fs.readFileSync(file),
        boxes: boxes(renderer),
        painted: renderer.getPaintedText(),
        tree: renderer.getAutomationTree(),
        a11y: scene.a11y ? withoutFrame(renderer.getA11yTree()) : null,
      })
    }
    const counters = renderer.getBuildCounters()
    return { frames, kept: counters.plansKept, computed: counters.plansComputed }
  } finally {
    root.unmount()
    renderer.setStyleCache(defaultMode())
  }
}

describeNative("the children plan cache", { timeout: 120_000 }, () => {
  afterAll(() => {
    // The switch is process wide: leave it as the run found it.
    const root = createTestRoot()
    root.renderer.setStyleCache(defaultMode())
    root.unmount()
  })

  for (const scene of scenes) {
    it(`draws ${scene.name} as the plan made every time does`, () => {
      const off = run(scene, "off")
      const on = run(scene, "on")
      const verified = run(scene, "verify")
      expect(off.kept, "an off cache keeps nothing").toBe(0)
      expect(off.computed, "an off cache plans every host with children").toBeGreaterThan(0)
      expect(on.kept, "an unchanged element finds its plan kept").toBeGreaterThan(0)
      expect(on.computed, "a changed one plans again").toBeGreaterThan(0)
      expect(on.kept + on.computed, "every host is asked once, kept or not").toBe(off.computed)
      expect(verified.kept, "verifying still finds plans kept").toBeGreaterThan(0)
      for (const other of [on, verified]) {
        for (let step = 0; step < scene.steps; step++) {
          expect(Buffer.compare(other.frames[step].picture, off.frames[step].picture), `the picture of step ${step}`).toBe(0)
          expect(other.frames[step].boxes, `the boxes of step ${step}`).toEqual(off.frames[step].boxes)
          expect(other.frames[step].painted, `the painted text of step ${step}`).toEqual(off.frames[step].painted)
          expect(other.frames[step].tree, `the automation tree of step ${step}`).toEqual(off.frames[step].tree)
          expect(other.frames[step].a11y, `the accessibility tree of step ${step}`).toEqual(off.frames[step].a11y)
        }
      }
    })
  }

  // Moving an element to another parent marks the two parent chains and leaves the element's own `subtree_revision` alone, so the
  // `white-space` it inherits is all that tells its kept plan the move happened. React recreates an instance it moves, hence the
  // moves go to the renderer, the way a portal-like host would make them.
  it("plans again an element moved between a normal and a pre parent", () => {
    const play = (mode: "off" | "on" | "verify") => {
      const root = createTestRoot({ width: 360, height: 200 })
      const renderer = root.renderer
      renderer.setStyleCache(mode)
      renderer.clockPause()
      try {
        root.render(
          <div style={{ width: 340, backgroundColor: "#ffffff", ...TEXT }}>
            <div style={{ ...BOX, whiteSpace: "normal" }}>
              <div>
                {"a   b\n  c  d "}
                <span style={{ fontWeight: "bold" }}>{"  bold   words "}</span>
              </div>
            </div>
            <div style={{ ...BOX, whiteSpace: "pre" }}>
              <div style={{ height: 14 }} />
            </div>
          </div>,
        )
        renderer.dispatchNativeEvents()
        renderer.flush()
        renderer.drawFrame()
        const page = renderer.toJSON()
        const normal = page.children[0].id
        const pre = page.children[1].id
        const placeholder = page.children[1].children[0].id
        const x = page.children[0].children[0].id
        const batches = [
          [["appendChild", pre, x]],
          [["appendChild", normal, x]],
          [["insertBefore", pre, x, placeholder]],
          [["appendChild", normal, x]],
        ]
        const read = () => ({ boxes: boxes(renderer), painted: renderer.getPaintedText(), tree: renderer.getAutomationTree() })
        renderer.resetBuildCounters()
        const frames = [{ ...read(), picture: null }]
        for (const [index, batch] of batches.entries()) {
          renderer.applyBatch(encodeWireBatchForTest(batch))
          renderer.flush()
          renderer.drawFrame()
          const file = path.join(SHOTS_DIR, `plan-cache-moved-${index}-${mode}.png`)
          renderer.captureScreenshot(file)
          frames.push({ ...read(), picture: fs.readFileSync(file) })
        }
        const counters = renderer.getBuildCounters()
        return { frames, kept: counters.plansKept }
      } finally {
        root.unmount()
        renderer.setStyleCache(defaultMode())
      }
    }
    const off = play("off")
    const on = play("on")
    const verified = play("verify")
    expect(off.frames[1].painted, "the move to the pre parent keeps the spaces").not.toEqual(off.frames[0].painted)
    expect(off.frames[2].painted, "and back to the normal parent collapses them again").toEqual(off.frames[0].painted)
    expect(on.kept, "what did not move is found kept").toBeGreaterThan(0)
    for (const other of [on, verified]) {
      for (let step = 0; step < off.frames.length; step++) {
        expect(other.frames[step].boxes, `the boxes of step ${step}`).toEqual(off.frames[step].boxes)
        expect(other.frames[step].painted, `the painted text of step ${step}`).toEqual(off.frames[step].painted)
        expect(other.frames[step].tree, `the automation tree of step ${step}`).toEqual(off.frames[step].tree)
        if (step > 0) expect(Buffer.compare(other.frames[step].picture, off.frames[step].picture), `the picture of step ${step}`).toBe(0)
      }
    }
  })

  it("plans only the host whose subtree changed", () => {
    const root = createTestRoot({ width: 360, height: 240 })
    const renderer = root.renderer
    renderer.setStyleCache("on")
    renderer.setRetainEnabled(false)
    renderer.clockPause()
    try {
      const page = (word: string) => (
        <div style={{ width: 340 }}>
          {[0, 1, 2, 3].map((row) => (
            <div key={row}>
              <div>{row === 2 ? word : "same"}</div>
              <span>{`row ${row}`}</span>
            </div>
          ))}
        </div>
      )
      root.render(page("one"))
      renderer.flush()
      renderer.drawFrame()
      renderer.resetBuildCounters()
      renderer.flush()
      renderer.drawFrame()
      const unchanged = renderer.getBuildCounters()
      expect(unchanged.plansComputed, "nothing changed").toBe(0)
      expect(unchanged.plansKept, "every host with children found its plan").toBeGreaterThan(0)
      renderer.resetBuildCounters()
      root.render(page("two"))
      renderer.dispatchNativeEvents()
      renderer.flush()
      renderer.drawFrame()
      const changed = renderer.getBuildCounters()
      expect(changed.plansComputed, "the row, the root above it and the text of the row: its ancestors").toBeGreaterThan(0)
      expect(changed.plansComputed, "the rows that did not change keep theirs").toBeLessThan(unchanged.plansKept)
    } finally {
      renderer.setRetainEnabled(true)
      root.unmount()
      renderer.setStyleCache(defaultMode())
    }
  })
})
