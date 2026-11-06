// @ts-nocheck
/**
 * A hover that only changes how elements paint is drawn as a tick (`events/hover_paint.rs`, patch-frames.md "Hover patches"),
 * which a patch frame takes: the roots that hold the restyled elements are built again and gpui writes their primitives over the
 * frame shown. A tick a patch cannot take is drawn whole in the same draw, so what the page shows, the boxes, what is under a point
 * and the cursor are what they are with patching off (`setPatchEnabled(false)`), whichever way the hover is drawn. Rows of 40 in a
 * view of 100, in a list with no scrollbar, and cards of a plain column.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays roots is built a second time and that build is the frame shown, and a patch is
// compared with the frame built whole after it: the cases that count patches skip there, and every case checks `mismatches`.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

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

/**
 * The page after the pointer went along `WAY` as far as `steps`, on a window of its own: a read of the picture
 * makes the screen reader of the test window flip, which a patch frame cannot follow, so the frames in between
 * are not read.
 */
function crossing(kind: Kind, hover: Hover, patch: boolean) {
  const entered: string[] = []
  const frames = []
  let patches
  let mismatches = 0
  for (let steps = 1; steps <= WAY.length; steps++) {
    const { renderer, unmount } = open(kind, hover, entered)
    try {
      renderer.setPatchEnabled(patch)
      // The first frames record the rows; the way goes over them once to have them recorded with a hover style.
      for (const y of WAY) move(renderer, 20, y)
      for (const y of WAY.slice(0, steps)) move(renderer, 20, y)
      const y = WAY[steps - 1]
      patches = renderer.getPatchCounters()
      frames.push(seen(renderer, `${kind}-${hover}-${patch}-${steps}`, [20, y]))
      mismatches += renderer.getRetainedCounters().mismatches
    } finally {
      unmount()
    }
  }
  return { frames, entered, patches, mismatches }
}

/** What patching did over `ys`, the pointer moving across the rows after the way once. */
function patched(kind: Kind, ys: number[], patch = true) {
  const { renderer, unmount } = open(kind, "paint")
  try {
    renderer.setPatchEnabled(patch)
    for (const y of WAY) move(renderer, 20, y)
    const before = renderer.getPatchCounters()
    renderer.resetBuildCounters()
    const frames = renderer.getPaintedFrameCount()
    for (const y of ys) move(renderer, 20, y)
    const after = renderer.getPatchCounters()
    const sum = (reasons: string) => Object.values(JSON.parse(reasons)).reduce((a: number, b: number) => a + b, 0)
    return {
      patchedFrames: after.patchedFrames - before.patchedFrames,
      patchedUnits: after.patchedUnits - before.patchedUnits,
      sceneRebuilds: after.sceneRebuilds - before.sceneRebuilds,
      inPlacePrimitives: after.inPlacePrimitives - before.inPlacePrimitives,
      declines: sum(after.declines) - sum(before.declines),
      unpatchable: sum(after.unpatchable) - sum(before.unpatchable),
      painted: renderer.getPaintedFrameCount() - frames,
      built: renderer.getBuildCounters().elementsBuilt,
    }
  } finally {
    unmount()
  }
}

describeNative("a hover that only paints", { timeout: TIMEOUT }, () => {
  for (const kind of ["column"] as const) {
    it(`draws what patching off draws, in a ${kind}`, () => {
      const on = crossing(kind, "paint", true)
      const off = crossing(kind, "paint", false)
      expect(on.frames).toEqual(off.frames)
      expect(on.mismatches).toBe(0)
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

  unverified("is a patched frame for each crossing, with nothing else built, in a column", () => {
    const crossings = [55, 95, 55, 20, 95, 20]
    const on = patched("column", crossings)
    expect(on.patchedFrames).toBe(crossings.length)
    expect(on.declines + on.unpatchable).toBe(0)
    expect(on.sceneRebuilds).toBeLessThanOrEqual(1)
    expect(on.inPlacePrimitives).toBeGreaterThan(0)
    expect(on.painted, "no frame is built whole").toBe(0)
    // The whole page is one root here, so a patch builds what a frame built whole does.
    expect(patched("column", crossings, false).patchedFrames).toBe(0)
  })

  for (const kind of ["column"] as const) {
    it(`finds the same pictures under the verifier and with the hover patched, in a ${kind}`, () => {
      // Under GPUIX_RETAIN_VERIFY=1 a patched frame is compared with the frame built whole after it.
      const on = crossing(kind, "paint", true)
      expect(on.frames).toEqual(crossing(kind, "paint", false).frames)
    })
  }
})

/** A page of more than a root may hold, with the group or the `:has(:hover)` ancestor around the rows. */
function Outer({ outside, fillers = 300 }: { outside: "group" | "has"; fillers?: number }) {
  const around =
    outside === "group"
      ? { group: true }
      : { backgroundColor: "#202020", hasHover: { backgroundColor: "#101820" } }
  return (
    <div testId="outer" style={{ width: 250, height: 200, ...around }}>
      <div style={{ width: 1, height: 1, flexDirection: "row" }}>
        {Array.from({ length: fillers }, (_, index) => (
          <div key={index} style={{ width: 0, height: 0 }} />
        ))}
      </div>
      <div style={{ width: 200, height: 100, flexDirection: "column" }}>
        {Array.from({ length: COUNT }, (_, index) => (
          <div
            key={index}
            style={{
              width: 150,
              height: ROW,
              flexShrink: 0,
              backgroundColor: "#223344",
              hover: { backgroundColor: "#664422" },
              groupHover: outside === "group" ? { backgroundColor: "#ff0000" } : undefined,
            }}
          >
            <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
          </div>
        ))}
      </div>
    </div>
  )
}

function around(outside: "group" | "has", patch: boolean, way: Array<[number, number]>, fillers = 300) {
  const frames = []
  let hovers = 0
  let patchedFrames = 0
  for (let steps = 1; steps <= way.length; steps++) {
    const root = createTestRoot({ width: 300, height: 200 })
    root.render(<Outer outside={outside} fillers={fillers} />)
    root.renderer.dispatchNativeEvents()
    root.renderer.flush()
    root.renderer.setA11yActive(false)
    const renderer = root.renderer
    try {
      renderer.setPatchEnabled(patch)
      for (const [x, y] of way) move(renderer, x, y)
      const before = renderer.getPatchCounters()
      for (const [x, y] of way.slice(0, steps)) move(renderer, x, y)
      const after = renderer.getPatchCounters()
      patchedFrames += after.patchedFrames - before.patchedFrames
      hovers += (JSON.parse(after.unpatchable).Hover ?? 0) - (JSON.parse(before.unpatchable).Hover ?? 0)
      frames.push(seen(renderer, `around-${outside}-${patch}-${steps}`, way[steps - 1]))
    } finally {
      root.unmount()
    }
  }
  return { frames, patchedFrames, hovers }
}

describeNative("a hover whose restyle is outside every root a patch can repaint", { timeout: TIMEOUT }, () => {
  // Inside the rows, between them, and in the outer box beside them (x = 220): the outer box is the group, or has the
  // `:has(:hover)` style, and loses and gains it each time the pointer crosses between the two.
  const way: Array<[number, number]> = [[20, 20], [20, 55], [220, 55], [20, 55], [20, 95], [220, 150], [20, 20]]

  unverified("draws a frame built whole, and the picture of patching off, for a :has(:hover) ancestor too big to be a root", () => {
    const on = around("has", true, way)
    expect(on.frames).toEqual(around("has", false, way).frames)
    expect(on.hovers, "the hover restyles an element no root holds").toBeGreaterThan(0)
    // The crossings between rows do not change it, and are patched.
    expect(on.patchedFrames).toBeGreaterThan(0)
  })

  it("draws a frame built whole, and the picture of patching off, for a group", () => {
    // A group, and the elements that follow it, are a frame built whole, however small.
    for (const fillers of [300, 0]) {
      const on = around("group", true, way, fillers)
      expect(on.frames).toEqual(around("group", false, way, fillers).frames)
      expect(on.patchedFrames).toBe(0)
    }
  })

  unverified("patches the hover of a :has(:hover) ancestor and the rows in it when they are in one root", () => {
    const on = around("has", true, way, 0)
    expect(on.frames).toEqual(around("has", false, way, 0).frames)
    expect(on.hovers).toBe(0)
    expect(on.patchedFrames).toBeGreaterThan(way.length)
  })
})
