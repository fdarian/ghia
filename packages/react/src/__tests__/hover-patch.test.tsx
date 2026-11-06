// @ts-nocheck
/**
 * A hover that only changes how elements paint is drawn as a tick (`events/hover_paint.rs`, patch-frames.md "Hover patches"). A
 * tick a patch cannot take is drawn whole in the same draw, so what the page shows, the boxes, what is under a point and the cursor
 * are what they are with patching off (`setPatchEnabled(false)`), whichever way the hover is drawn. Rows of 40 in a view of 100,
 * in a list with no scrollbar, and cards of a plain column.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ROW = 40
const COUNT = 12
const TIMEOUT = 60_000

type Kind = "list" | "column"

/** A paint-only hover, one that changes the padding, and one that has a `pointerenter` listener. */
type Hover = "paint" | "padding" | "listener"

function Row({ index, hover, onEnter }: { index: number; hover: Hover; onEnter: () => void }) {
  const refinement =
    hover === "padding" ? { backgroundColor: "#664422", paddingLeft: 8 } : { backgroundColor: "#664422" }
  return (
    <div
      testId={`row-${index}`}
      onPointerEnter={hover === "listener" ? onEnter : undefined}
      style={{
        width: 150,
        height: ROW,
        flexShrink: 0,
        backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
        borderBottom: "1px solid #112233",
        hover: refinement,
      }}
    >
      <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
    </div>
  )
}

function Page({ kind, hover, onEnter }: { kind: Kind; hover: Hover; onEnter: () => void }) {
  const rows = Array.from({ length: COUNT }, (_, index) => <Row key={index} index={index} hover={hover} onEnter={onEnter} />)
  if (kind === "column") {
    return (
      <div testId="column" style={{ width: 200, height: 100, flexDirection: "column", overflow: "hidden" }}>
        {rows}
      </div>
    )
  }
  return (
    <virtual-list
      testId="list"
      itemCount={COUNT}
      estimatedItemHeight={ROW}
      overdraw={0}
      style={{ width: 200, height: 100, scrollbarWidth: "none" }}
    >
      {rows}
    </virtual-list>
  )
}

function open(kind: Kind, hover: Hover, entered: string[] = []) {
  const root = createTestRoot({ width: 300, height: 200 })
  root.render(<Page kind={kind} hover={hover} onEnter={() => entered.push("enter")} />)
  root.renderer.dispatchNativeEvents()
  root.renderer.flush()
  root.renderer.setA11yActive(false)
  return root
}

function picture(renderer, name: string): string {
  const file = `${SHOTS_DIR}/hover-patch-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureScreenshot(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const element of renderer.findByType("div")) {
    const box = renderer.getElementBounds(element.id)
    if (box) out[String(element.id)] = box
  }
  return out
}

/** What a test observes of the page after a step. */
function seen(renderer, name: string, point: [number, number]) {
  return {
    boxes: boxes(renderer),
    under: renderer.getElementsAt(point[0], point[1]),
    cursor: renderer.getCursor(),
    picture: picture(renderer, name),
  }
}

function move(renderer, x: number, y: number) {
  renderer.nativeSimulateMouseMove(x, y)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

/** The ticks the page asked for: a patch frame was tried for each, and each was patched or counted under a reason. */
function ticks(counters): number {
  const sum = (reasons: string) => Object.values(JSON.parse(reasons)).reduce((a: number, b: number) => a + b, 0)
  return counters.patchedFrames + counters.emptyTicks + sum(counters.declines) + sum(counters.unpatchable)
}

/** The pointer crossing the rows from the first to the last and back, seen after each move. */
const WAY = [20, 55, 95, 55, 20, 95, 20]

function crossing(kind: Kind, hover: Hover, patch: boolean) {
  const entered: string[] = []
  const { renderer, unmount } = open(kind, hover, entered)
  try {
    renderer.setPatchEnabled(patch)
    // The first frames record the rows; the way goes over them once to have them recorded with a hover style.
    for (const y of WAY) move(renderer, 20, y)
    const frames = WAY.map((y, index) => {
      move(renderer, 20, y)
      return seen(renderer, `${kind}-${hover}-${patch}-${index}`, [20, y])
    })
    return { frames, entered, patches: renderer.getPatchCounters() }
  } finally {
    unmount()
  }
}

describeNative("a hover that only paints", { timeout: TIMEOUT }, () => {
  for (const kind of ["list", "column"] as const) {
    it(`draws what patching off draws, in a ${kind}`, () => {
      const on = crossing(kind, "paint", true)
      const off = crossing(kind, "paint", false)
      expect(on.frames).toEqual(off.frames)
      expect(on.frames[0].picture).not.toEqual(on.frames[1].picture)
      expect(ticks(on.patches)).toBeGreaterThan(0)
      expect(ticks(off.patches)).toBe(0)
    })

    it(`draws what patching off draws when the hover changes the padding, in a ${kind}`, () => {
      const on = crossing(kind, "padding", true)
      expect(on.frames).toEqual(crossing(kind, "padding", false).frames)
      expect(ticks(on.patches), "a hover that lays out is drawn by the frame that is asked for").toBe(0)
    })

    it(`draws what patching off draws and sends the events when a row listens for the pointer, in a ${kind}`, () => {
      const on = crossing(kind, "listener", true)
      const off = crossing(kind, "listener", false)
      expect(on.frames).toEqual(off.frames)
      expect(on.entered.length).toBeGreaterThan(0)
      expect(on.entered).toEqual(off.entered)
      expect(ticks(on.patches), "a hover that a script hears is a frame").toBe(0)
    })
  }
})
