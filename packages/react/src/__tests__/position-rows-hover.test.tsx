// @ts-nocheck
/**
 * The rows of a TanStack Virtual list (`position: absolute`, a `translateY` transform, a `:hover` background and an
 * absolutely positioned box of their own, in a `position: relative` container in an `overflow: auto` scroller) are hover
 * patch roots: a row lifts itself and forms a stacking context, so what it lifts is lifted in it, and a patch repaints
 * it in the place the context of the page orders it (patch-frames.md "Hover patches"). A pointer that crosses rows is a
 * patched frame, and what it shows, the boxes and what is under a point are what a frame built whole shows.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { defineKeyframes } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROWS = 20
const ROW_HEIGHT = 40
const VIEW = { width: 300, height: 200 }
const TAG = { left: 120, top: 6, width: 50, height: 10 }
const HOVERED = [102, 68, 34, 255]
const RED = [255, 0, 0, 255]
const TIMEOUT = 60_000

function Rows() {
  return (
    <div testId="scroller" style={{ ...VIEW, overflow: "auto", scrollbarWidth: "none" }}>
      <div testId="container" style={{ position: "relative", width: "100%", height: ROWS * ROW_HEIGHT }}>
        {Array.from({ length: ROWS }, (_, index) => (
          <div
            key={index}
            testId={`row-${index}`}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: ROW_HEIGHT,
              transform: `translateY(${index * ROW_HEIGHT}px)`,
              backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
              hover: { backgroundColor: "#664422" },
            }}
          >
            <div style={{ fontSize: 14, color: "#ffffff" }}>{`Row ${index}`}</div>
            <div
              testId={`tag-${index}`}
              style={{
                position: "absolute",
                left: TAG.left,
                top: TAG.top,
                width: TAG.width,
                height: TAG.height,
                backgroundColor: "#ff0000",
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function open(verify: boolean, patch: boolean) {
  const root = createTestRoot(VIEW)
  const renderer = root.renderer
  renderer.setRetainPlanning(true)
  renderer.setRetainVerify(verify)
  root.render(<Rows />)
  for (let frame = 0; frame < 5; frame++) renderer.flush()
  renderer.dispatchNativeEvents()
  renderer.setA11yActive(false)
  renderer.setPatchEnabled(patch)
  return root
}

function move(renderer, x: number, y: number) {
  renderer.nativeSimulateMouseMove(x, y)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const element of renderer.findByType("div")) {
    const box = renderer.getElementBounds(element.id)
    if (box) out[String(element.id)] = box
  }
  return out
}

/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function pixels(renderer, name: string, points: [number, number][]) {
  const file = `${SHOTS_DIR}/position-rows-hover-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const at = readLogicalPixels(file, renderer)
  fs.rmSync(file, { force: true })
  return points.map(([x, y]) => at.at(x, y))
}

const WAY = [20, 55, 95, 55, 20, 95, 20]
const SAMPLES: [number, number][] = [
  [20, 20],
  [20, 55],
  [20, 95],
  [TAG.left + 5, TAG.top + 5],
  [TAG.left + 5, ROW_HEIGHT + TAG.top + 5],
]

describeNative("rows that are positioned, moved by a transform and hold a positioned box, under a pointer", { timeout: TIMEOUT }, () => {
  it("show what a frame built whole shows when the pointer crosses them, under the verifier", () => {
    const run = (patch: boolean) => {
      const frames = []
      let mismatches = 0
      for (let steps = 1; steps <= WAY.length; steps++) {
        const { renderer, unmount } = open(true, patch)
        try {
          for (const y of WAY) move(renderer, 20, y)
          for (const y of WAY.slice(0, steps)) move(renderer, 20, y)
          const y = WAY[steps - 1]
          frames.push({
            boxes: boxes(renderer),
            under: renderer.getElementsAt(20, y),
            tag: renderer.getElementsAt(TAG.left + 5, Math.floor(y / ROW_HEIGHT) * ROW_HEIGHT + TAG.top + 5),
            pixels: pixels(renderer, `${patch}-${steps}`, SAMPLES),
          })
          mismatches += renderer.getRetainedCounters().mismatches
        } finally {
          unmount()
        }
      }
      return { frames, mismatches }
    }
    const on = run(true)
    const off = run(false)
    expect(on.frames).toEqual(off.frames)
    expect(on.mismatches).toBe(0)
    // The row under the pointer shows its hover and the box in it is still on top of it.
    expect(on.frames[0].pixels[0]).toEqual(HOVERED)
    expect(on.frames[0].pixels[3]).toEqual(RED)
    expect(on.frames[1].pixels[1]).toEqual(HOVERED)
    expect(on.frames[1].pixels[0]).not.toEqual(HOVERED)
  })

  unverified("is a patched frame for each crossing of a row, with nothing built whole", () => {
    const crossings = [55, 95, 55, 20, 95, 20]
    const { renderer, unmount } = open(false, true)
    try {
      for (const y of WAY) move(renderer, 20, y)
      const before = renderer.getPatchCounters()
      const painted = renderer.getPaintedFrameCount()
      for (const y of crossings) move(renderer, 20, y)
      const after = renderer.getPatchCounters()
      const sum = (reasons: string) => Object.values(JSON.parse(reasons)).reduce((a: number, b: number) => a + b, 0)
      expect(after.patchedFrames - before.patchedFrames, `${after.declines} ${after.unpatchable}`).toBe(crossings.length)
      expect(sum(after.declines) - sum(before.declines)).toBe(0)
      expect(sum(after.unpatchable) - sum(before.unpatchable)).toBe(0)
      expect(renderer.getPaintedFrameCount() - painted, "no frame is built whole").toBe(0)
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
    } finally {
      unmount()
    }
  })
})

/**
 * The scan that decides a hover patch root reads the declared style. A row whose declared style forms no context, or does,
 * but is built with another (an animation that ends at opacity 1, a state that sets it), has to be judged as one whose
 * lifted children may be lifted out of it: a patched frame must still show what a frame built whole shows.
 */
defineKeyframes("rows-fade-in", { from: { opacity: 0 }, to: { opacity: 1 } })

const BG = ["#223344", "#334455"]

/** The badge of a row that reaches into the next row, so that where the context orders it shows. */
const REACH = { ...TAG, top: 30, height: 20 }

type Variant = { name: string; row: (index: number) => Record<string, unknown>; inner?: Record<string, unknown>; tag?: typeof TAG }

function Restyled({ variant }: { variant: Variant }) {
  return (
    <div testId="scroller" style={{ ...VIEW, overflow: "auto", scrollbarWidth: "none" }}>
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          testId={`row-${index}`}
          style={{
            height: ROW_HEIGHT,
            backgroundColor: BG[index % 2],
            hover: { backgroundColor: "#664422" },
            ...variant.row(index),
          }}
        >
          {variant.inner ? (
            <div testId={`plane-${index}`} style={variant.inner}>
              <div style={{ position: "absolute", ...(variant.tag ?? TAG), backgroundColor: "#ff0000" }} />
            </div>
          ) : (
            <div style={{ position: "absolute", ...(variant.tag ?? TAG), backgroundColor: "#ff0000" }} />
          )}
          <div style={{ fontSize: 14, color: "#ffffff" }}>{`Row ${index}`}</div>
        </div>
      ))}
    </div>
  )
}

const VARIANTS: Variant[] = [
  { name: "an animation that ends at opacity 1", row: () => ({ opacity: 0, animation: "rows-fade-in 100ms linear forwards" }) },
  { name: "an active state that sets opacity 1 over a lower one", row: () => ({ opacity: 0.5, active: { opacity: 1 } }) },
  { name: "a child with preserve-3d that holds the lifted box", row: () => ({}), inner: { transformStyle: "preserve-3d" } },
  { name: "a child with a scale that holds the lifted box", row: () => ({}), inner: { scale: "1.01 1" } },
  {
    name: "a row with a hover that crosses opacity 1 and holds a lifted box",
    row: () => ({ opacity: 0.5, hover: { backgroundColor: "#664422", opacity: 1 } }),
    tag: REACH,
  },
]

describeNative("hover patches of rows that are restyled other than by their hover", { timeout: TIMEOUT }, () => {
  for (const variant of VARIANTS) {
    it(`show what a frame built whole shows with ${variant.name}, under the verifier`, () => {
      const run = (patch: boolean) => {
        const root = createTestRoot(VIEW)
        const renderer = root.renderer
        renderer.clockPause()
        renderer.setRetainPlanning(true)
        renderer.setRetainVerify(true)
        root.render(<Restyled variant={variant} />)
        for (let frame = 0; frame < 5; frame++) renderer.flush()
        renderer.clockFastForward(500)
        for (let frame = 0; frame < 3; frame++) renderer.flush()
        renderer.dispatchNativeEvents()
        renderer.setA11yActive(false)
        renderer.setPatchEnabled(patch)
        try {
          const frames = []
          const way = [20, 60, 100, 60, 20, 100, 20]
          for (const y of way) move(renderer, 20, y)
          if (variant.name.startsWith("an active")) renderer.nativeSimulateMouseDown(20, 20)
          for (const y of way) {
            move(renderer, 20, y)
            frames.push({
              boxes: boxes(renderer),
              under: renderer.getElementsAt(20, y),
              pixels: pixels(renderer, `${variant.name.replace(/\W+/g, "-")}-${patch}-${frames.length}`, [
                [20, 20],
                [20, 60],
                [20, 100],
                [TAG.left + 5, TAG.top + 5],
                [REACH.left + 5, ROW_HEIGHT + 5],
              ]),
            })
          }
          return { frames, mismatches: renderer.getRetainedCounters().mismatches }
        } finally {
          root.unmount()
        }
      }
      const on = run(true)
      const off = run(false)
      expect(on.frames).toEqual(off.frames)
      expect(on.mismatches).toBe(0)
      expect(off.mismatches).toBe(0)
    })
  }
})
