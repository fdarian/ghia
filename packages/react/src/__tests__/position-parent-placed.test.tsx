/// An absolute box in the positioned box that holds it is placed by that box's own layout (taffy resolves
/// it against its parent) and not by a walk to the nearest positioned ancestor. It lays out, paints and
/// answers the pointer where the walk puts it, and a parent that stops being positioned hands it to the
/// containing block outside, with the retained frames the box is in never replaying the old placement.

import fs from "fs"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Position = "relative" | "static" | "absolute" | "sticky"

/** The box that is placed at (10, 15) of its containing block, and the lines in it that make it a subtree worth keeping. */
function Placed(props: { onClick?: () => void; style?: Record<string, unknown> }) {
  return (
    <div
      testId="placed"
      onClick={props.onClick}
      style={{ position: "absolute", left: 10, top: 15, width: 60, height: 40, backgroundColor: "#ff0000", ...props.style }}
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} style={{ height: 4 }}>
          line
        </div>
      ))}
    </div>
  )
}

/** A containing block at (0, 0) with its content at (100, 50), the `parent` there, and the box in it. */
function Page(props: { position: Position; children?: ReactNode; parentStyle?: Record<string, unknown> }) {
  return (
    <div testId="outer" style={{ position: "relative", width: 400, height: 300, paddingLeft: 100, paddingTop: 50 }}>
      <div testId="parent" style={{ position: props.position, width: 200, height: 100, ...props.parentStyle }}>
        {props.children ?? <Placed />}
      </div>
    </div>
  )
}

function setup(retention = false) {
  const root = createTestRoot({ width: 400, height: 300 })
  const renderer = root.renderer
  if (retention) {
    renderer.setRetainPlanning(true)
    renderer.setRetainVerify(true)
  }
  const bounds = (testId: string) => renderer.getElementBounds(renderer.findByTestId(testId)!.id)!
  const sample = (name: string, x: number, y: number) => {
    const file = `${SHOTS_DIR}/position-parent-placed-${process.pid}-${name}.png`
    fs.rmSync(file, { force: true })
    renderer.captureScreenshot(file)
    return readLogicalPixels(file, renderer).at(x, y)
  }
  const settle = () => {
    for (let frame = 0; frame < 5; frame++) renderer.flush()
  }
  const counters = () => renderer.getRetainedCounters()
  return { ...root, bounds, sample, settle, counters }
}

const RED = [255, 0, 0, 255]

describeNative("an absolute box in the positioned box that holds it", () => {
  it("lays out, paints and answers the pointer where the containing block puts it", () => {
    const clicks: string[] = []
    const { render, renderer, bounds, sample, unmount } = setup()
    try {
      render(
        <Page position="relative">
          <Placed onClick={() => clicks.push("placed")} />
        </Page>
      )
      renderer.dispatchNativeEvents()

      expect(bounds("placed")).toMatchObject({ x: 110, y: 65, width: 60, height: 40 })
      expect(sample("relative", 140, 85)).toEqual(RED)
      expect(sample("relative-outside", 20, 30)).not.toEqual(RED)
      expect(renderer.getElementsAt(140, 85)).toContain(renderer.findByTestId("placed")!.id)
      renderer.nativeSimulateClick(140, 85)
      expect(clicks).toEqual(["placed"])
    } finally {
      unmount()
    }
  })

  it("is placed by a parent that is itself absolute or sticky, and by one that does not clip it", () => {
    const { render, bounds, unmount } = setup()
    try {
      for (const position of ["absolute", "sticky"] as const) {
        render(<Page position={position} parentStyle={position === "absolute" ? { left: 100, top: 50 } : {}} />)
        expect(bounds("placed"), position).toMatchObject({ x: 110, y: 65 })
      }
      render(<Page position="relative" parentStyle={{ overflow: "hidden", width: 40, height: 20 }} />)
      expect(bounds("placed")).toMatchObject({ x: 110, y: 65, width: 60, height: 40 })
    } finally {
      unmount()
    }
  })

  it("is clipped and moved by a positioned scroller that holds it", () => {
    const clicks: string[] = []
    const { render, renderer, bounds, unmount } = setup()
    try {
      render(
        <div style={{ width: 400, height: 300 }}>
          <div testId="scroller" style={{ position: "relative", width: 100, height: 100, overflow: "scroll" }}>
            <div style={{ height: 1000 }} />
            <Placed onClick={() => clicks.push("placed")} style={{ left: 10, top: 60 }} />
          </div>
        </div>
      )
      renderer.dispatchNativeEvents()
      expect(bounds("placed")).toMatchObject({ x: 10, y: 60 })

      renderer.scrollTo(renderer.findByTestId("scroller")!.id, 0, 40)
      renderer.flush()

      expect(bounds("placed")).toMatchObject({ x: 10, y: 20 })
      renderer.nativeSimulateClick(30, 30)
      expect(clicks).toEqual(["placed"])
    } finally {
      unmount()
    }
  })

  it("moves to the containing block outside when its parent stops being positioned, and back", () => {
    const { render, renderer, bounds, sample, settle, counters, unmount } = setup(true)
    try {
      render(<Page position="relative" />)
      settle()
      expect(bounds("placed")).toMatchObject({ x: 110, y: 65 })
      expect(sample("toggle-relative", 140, 85)).toEqual(RED)
      const replays = counters().replays
      renderer.flush()
      expect(counters().replays, "the frames of a page that does not change replay it").toBeGreaterThan(replays)

      render(<Page position="static" />)
      settle()
      expect(bounds("placed")).toMatchObject({ x: 10, y: 15, width: 60, height: 40 })
      expect(sample("toggle-static", 30, 35)).toEqual(RED)
      expect(sample("toggle-static-old", 140, 85)).not.toEqual(RED)

      render(<Page position="relative" />)
      settle()
      expect(bounds("placed")).toMatchObject({ x: 110, y: 65 })
      expect(sample("toggle-back", 140, 85)).toEqual(RED)
      expect(sample("toggle-back-old", 30, 35)).not.toEqual(RED)

      expect(counters().mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
    } finally {
      unmount()
    }
  })

  it("moves with a parent that is positioned by a hover, which no revision of the box says", () => {
    const { render, renderer, bounds, settle, unmount } = setup(true)
    try {
      render(<Page position="relative" parentStyle={{ hover: { position: "static" } }} />)
      settle()
      expect(bounds("placed")).toMatchObject({ x: 110, y: 65 })

      renderer.nativeSimulateMouseMove(150, 100)
      settle()
      expect(bounds("placed")).toMatchObject({ x: 10, y: 15 })

      renderer.nativeSimulateMouseMove(399, 299)
      settle()
      expect(bounds("placed")).toMatchObject({ x: 110, y: 65 })
      expect(renderer.getRetainedCounters().mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
    } finally {
      unmount()
    }
  })

  it("keeps a static parent that has a transform as the containing block it was", () => {
    const { render, bounds, settle, unmount } = setup(true)
    try {
      render(<Page position="static" parentStyle={{ transform: "translateX(0px) scale(1)" }} />)
      settle()
      expect(bounds("placed")).toMatchObject({ x: 110, y: 65 })
    } finally {
      unmount()
    }
  })
})
