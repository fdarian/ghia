// @ts-nocheck
/**
 * A text with nothing else to place is one gpui element (`text/leaf.rs`) where it was a wrapper `div`, an underlay canvas and the
 * glyphs. The switch (`setTextLeafEnabled`) is process wide and read at every build, so each scene is mounted in a window of its
 * own under each setting and the two are compared: the picture (the PNG bytes), the boxes of every element, what was painted, what
 * a drag selects, the registries, the layout nodes made. The leaf does its work in fewer elements and no other way.
 */

import fs from "node:fs"
import path from "node:path"
import React from "react"
import { afterAll, describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const TEXT = { fontSize: 15, lineHeight: "20px", color: "#112233" } as const

type Scene = {
  name: string
  page: () => React.ReactElement
  /** Runs on the mounted page before it is read: a drag, a scroll, a pointer move. */
  act?: (renderer: any) => void
  width?: number
  height?: number
}

const sentence = "The quick brown fox jumps over the lazy dog and keeps running past the river bank"

const scenes: Scene[] = [
  {
    name: "plain",
    page: () => (
      <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        <div testId="a" style={TEXT}>{sentence}</div>
        <div testId="b" style={{ ...TEXT, textAlign: "center", fontWeight: 700, color: "#aa2200" }}>centered label</div>
        <div testId="c" style={{ ...TEXT, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden", width: 120 }}>{sentence}</div>
        <div testId="d" style={{ ...TEXT, lineClamp: 2, width: 140 }}>{sentence}</div>
        <div testId="e" style={{ ...TEXT, textDecoration: "underline", letterSpacing: 1, textAlign: "right" }}>underlined</div>
        <div testId="f" style={{ ...TEXT, userSelect: "none" }}>not selectable</div>
        <div style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <div testId="g" style={{ ...TEXT, fontSize: 28, lineHeight: "32px" }}>Big</div>
          <div testId="h" style={TEXT}>small beside</div>
        </div>
      </div>
    ),
  },
  {
    name: "selection",
    page: () => (
      <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        <div testId="a" style={TEXT}>{sentence}</div>
        <div testId="b" style={TEXT}>second paragraph of the page</div>
        <div testId="c" style={{ ...TEXT, userSelect: "none" }}>chrome</div>
        <div testId="d" style={TEXT}>{sentence}</div>
      </div>
    ),
    act: (renderer) => {
      renderer.dragSelect(20, 10, 200, 90)
    },
  },
  {
    name: "paragraph",
    page: () => (
      <div style={{ width: 320, backgroundColor: "#ffffff" }}>
        <div testId="p1" style={TEXT}>
          plain <span style={{ color: "#cc0000", fontWeight: 700 }}>red <span style={{ backgroundColor: "#ffee00" }}>marked</span></span> tail
          and <span style={{ backgroundColor: "#cceeff", padding: "0 4px", borderRadius: 4 }}>a pill</span> then more words to wrap the line
        </div>
        <div testId="p2" style={TEXT}>
          one <span onClick={() => {}} style={{ color: "#0000ff", textDecoration: "underline" }}>clickable</span> span and{" "}
          <span style={{ fontSize: 22, verticalAlign: "top" }}>big</span> ones
        </div>
        <div testId="p3" style={TEXT}>
          Hello {"name"}! <span style={{ color: "#008800" }}>{"interpolated"}</span>
        </div>
      </div>
    ),
    act: (renderer) => {
      renderer.dragSelect(10, 5, 250, 70)
    },
  },
  {
    name: "paragraph-extras",
    page: () => (
      <div style={{ width: 320, backgroundColor: "#ffffff" }}>
        <div testId="o1" style={TEXT}>
          with <span style={{ outline: "2px solid #ff00ff", outlineOffset: 1 }}>an outline</span> inside
        </div>
        <div testId="o2" style={TEXT}>
          with <span style={{ opacity: 0.4, backgroundColor: "#ffaa00" }}>a faded span</span> inside
        </div>
        <div testId="o3" style={TEXT}>
          with <span style={{ cursor: "pointer" }}>a cursor</span> inside
        </div>
        <div testId="o4" style={TEXT}>
          with <span style={{ display: "inline-block", width: 40, height: 14, backgroundColor: "#00aa88" }} /> a box
        </div>
        <div testId="o5" style={TEXT}>
          with <span tabIndex={0} style={{ color: "#6600cc" }}>a tab stop</span> inside
        </div>
      </div>
    ),
  },
  {
    name: "highlight",
    page: () => (
      <div style={{ width: 300, backgroundColor: "#ffffff" }} highlight={{ query: "quick" }}>
        <div testId="a" style={TEXT}>{sentence}</div>
        <div testId="b" style={TEXT}>
          a <span style={{ color: "#cc0000" }}>quick</span> paragraph that is quick too
        </div>
      </div>
    ),
  },
  {
    name: "scroller",
    width: 320,
    height: 240,
    page: () => (
      <div testId="scroller" style={{ width: 300, height: 200, overflow: "auto", backgroundColor: "#ffffff" }}>
        {Array.from({ length: 60 }, (_, index) => (
          <div key={index} style={{ height: 26, padding: "3px 8px", backgroundColor: index % 2 ? "#f4f4f4" : "#ffffff" }}>
            <div style={TEXT}>{`row ${index} ${sentence.slice(0, 12 + (index % 5) * 6)}`}</div>
          </div>
        ))}
      </div>
    ),
    act: (renderer) => {
      const scroller = renderer.findByTestId("scroller")
      renderer.scrollTo(scroller.id, undefined, 400)
      renderer.dragSelect(20, 20, 200, 120)
    },
  },
  {
    name: "hover-rows",
    width: 320,
    height: 240,
    page: () => (
      <div style={{ width: 300, display: "flex", flexDirection: "column", backgroundColor: "#ffffff" }}>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} style={{ height: 30, padding: "4px 8px", backgroundColor: "#eeeeee", hover: { backgroundColor: "#ffddaa" } }}>
            <div style={TEXT}>{`hover row ${index}`}</div>
          </div>
        ))}
      </div>
    ),
    act: (renderer) => {
      renderer.nativeSimulateMouseMove(40, 45)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
    },
  },
  {
    name: "transformed",
    page: () => (
      <div style={{ width: 300, height: 160, backgroundColor: "#ffffff" }}>
        <div style={{ transform: "rotate(6deg)", transformOrigin: "0 0", margin: 20, width: 200 }}>
          <div testId="r" style={TEXT}>{sentence}</div>
        </div>
        <div style={{ perspective: 300 }}>
          <div style={{ transformStyle: "preserve-3d", transform: "rotateY(20deg)", width: 160 }}>
            <div testId="s" style={TEXT}>tilted plane of text</div>
          </div>
        </div>
      </div>
    ),
    act: (renderer) => {
      renderer.dragSelect(30, 30, 150, 60)
    },
  },
  {
    name: "tables-and-grids",
    page: () => (
      <div style={{ width: 320, backgroundColor: "#ffffff" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 4 }}>
          <div style={TEXT}>left cell</div>
          <div style={TEXT}>{sentence}</div>
          <div style={TEXT}>second row</div>
          <div style={TEXT}>x</div>
        </div>
        <div style={{ display: "table", borderCollapse: "collapse" }}>
          <div style={{ display: "table-row" }}>
            <div style={{ display: "table-cell", padding: 4 }}><div style={TEXT}>cell one</div></div>
            <div style={{ display: "table-cell", padding: 4 }}><div style={TEXT}>cell two is longer</div></div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
          <div style={{ ...TEXT, flexShrink: 0 }}>no shrink</div>
          <div style={{ ...TEXT, flex: 1 }}>{sentence}</div>
        </div>
      </div>
    ),
    act: (renderer) => {
      renderer.dragSelect(5, 5, 280, 120)
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

function run(scene: Scene, leaf: boolean) {
  const root = createTestRoot({ width: scene.width ?? 400, height: scene.height ?? 300 })
  const renderer = root.renderer
  renderer.setTextLeafEnabled(leaf)
  try {
    root.render(scene.page())
    renderer.dispatchNativeEvents()
    renderer.flush()
    renderer.setA11yActive(false)
    renderer.drawFrame()
    scene.act?.(renderer)
    const file = path.join(SHOTS_DIR, `text-leaf-${scene.name}-${leaf ? "leaf" : "wrapper"}.png`)
    const work = renderer.getFrameWorkCounters()
    renderer.captureScreenshot(file)
    return {
      picture: fs.readFileSync(file),
      boxes: boxes(renderer),
      painted: renderer.getPaintedText(),
      highlights: renderer.getPaintedHighlights(),
      selected: renderer.getSelectedText(),
      slots: renderer.getRegistrySlots(),
      nodes: renderer.getLayoutCounters().nodesCreated,
      prepainted: work.prepainted,
      layoutDump: renderer.getAutomationTree(),
    }
  } finally {
    root.unmount()
    renderer.setTextLeafEnabled(true)
  }
}

describeNative("a text built as one element", { timeout: 60_000 }, () => {
  afterAll(() => {
    // The switch is process wide: leave it as the run found it.
    const root = createTestRoot()
    root.renderer.setTextLeafEnabled(process.env.GPUIX_TEXT_LEAF_OFF === undefined)
    root.unmount()
  })

  for (const scene of scenes) {
    it(`draws ${scene.name} as the wrapper does`, () => {
      const wrapper = run(scene, false)
      const leaf = run(scene, true)
      expect(Buffer.compare(leaf.picture, wrapper.picture), "the picture").toBe(0)
      expect(leaf.boxes).toEqual(wrapper.boxes)
      expect(leaf.painted).toEqual(wrapper.painted)
      expect(leaf.highlights).toEqual(wrapper.highlights)
      expect(leaf.selected).toEqual(wrapper.selected)
      expect(leaf.slots).toEqual(wrapper.slots)
      expect(leaf.layoutDump).toEqual(wrapper.layoutDump)
      expect(leaf.nodes).toBeLessThanOrEqual(wrapper.nodes)
    })
  }

  it("prepaints and paints fewer elements for the same texts", () => {
    const scene = scenes[0]
    const wrapper = run(scene, false)
    const leaf = run(scene, true)
    expect(leaf.prepainted).toBeLessThan(wrapper.prepainted)
    expect(leaf.nodes).toBeLessThan(wrapper.nodes)
  })
})
