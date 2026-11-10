// @ts-nocheck
/**
 * A wheel under a pointer that stays moves the rows of a list under it, and the row it is over changes. A hover that only paints
 * (a row that takes another background colour) does not hold the translate (`Hover`): the rows are moved, and the tick the hover
 * follows the frame with repaints the two rows where the translate left them (`hoverMatters` stays 0, `patchedFrames` counts the
 * repaints, and no frame is built whole). The picture, the boxes and what is under a point are what they are with the translate off.
 * A hover a listener hears is a frame built whole still.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: the rows
// are built, not replayed, so the next scroll has nothing to translate. The verified case below makes its own frames.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const X = 100
const Y = 50
const TIMEOUT = 120_000

type Rows = "paint" | "heard"

function Page({ rows }: { rows: Rows }) {
  return (
    <virtual-list
      testId="list"
      itemCount={COUNT}
      estimatedItemHeight={ROW}
      overdraw={0}
      style={{ width: 200, height: VIEWPORT, scrollbarWidth: "none" }}
    >
      {Array.from({ length: COUNT }, (_, index) => (
        <div
          key={index}
          testId={`row-${index}`}
          style={{
            height: ROW,
            flexShrink: 0,
            backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
            hover: { backgroundColor: "#664422" },
          }}
          {...(rows === "heard" ? { onPointerEnter: () => {} } : {})}
        >
          <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
        </div>
      ))}
    </virtual-list>
  )
}

function open(rows: Rows) {
  const root = createTestRoot({ width: 300, height: 200 })
  root.render(<Page rows={rows} />)
  const renderer = root.renderer
  renderer.setA11yActive(false)
  renderer.dispatchNativeEvents()
  renderer.flush()
  const list = renderer.findByTestId("list")!.id
  // Every row measured, by showing each once with the translate off: a row with no measured size is a frame built whole.
  renderer.setScrollPatchEnabled(false)
  for (let scrolled = 0; scrolled <= COUNT * ROW - VIEWPORT; scrolled += 20) renderer.scrollTo(list, 0, scrolled)
  renderer.scrollTo(list, 0, 0)
  renderer.setScrollPatchEnabled(true)
  return { ...root, renderer, list }
}

const scroll = (renderer) => renderer.getPatchCounters().scrollPatch

/**
 * Builds every row that shows where it is and leaves it as such a frame leaves it: nothing replayed. A row a whole frame put
 * elsewhere than it was recorded is not a root a patch can repaint until a frame builds it again.
 */
function rebuild(renderer) {
  renderer.nativeSimulateMouseMove(X, Y)
  renderer.dispatchNativeEvents()
  renderer.setRetainPlanning(false)
  renderer.setRetainPlanning(true)
  renderer.flush()
}

function picture(renderer, name: string): string {
  const file = `${SHOTS_DIR}/scroll-patch-hover-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const element of renderer.findByType("div")) {
    const box = renderer.getElementBounds(element.id)
    if (box) out[String(element.testId ?? element.id)] = box
  }
  return out
}

/**
 * One wheel event and the frames a window draws for it: the translate, and the tick that follows it, which repaints the rows the
 * pointer left and entered. `flush` would notify the view and draw a frame built whole each call.
 */
function wheel(renderer, by: number) {
  renderer.nativeSimulateScrollWheel(X, Y, 0, by)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
  renderer.drawFrame()
}

/** The steps of a wheel that crosses two row borders down and two back up, then a few that stay in a row. */
const STEPS = [...Array.from({ length: 6 }, () => 15), ...Array.from({ length: 6 }, () => -15), 5, 5, -5, -5]

/** How many times the pointer meets another row over the steps, from a list scrolled to 200. */
const CROSSINGS = STEPS.reduce(
  (found, by) => {
    const scrolled = found.scrolled + by
    return { scrolled, count: found.count + Number(Math.floor((scrolled + Y) / ROW) !== Math.floor((found.scrolled + Y) / ROW)) }
  },
  { scrolled: 200, count: 0 },
).count

/** The row under the pointer, from what is under it. */
function rowUnder(renderer): number | undefined {
  const ids = renderer.getElementsAt(X, Y)
  for (let row = 0; row < COUNT; row += 1) {
    const found = renderer.findByTestId(`row-${row}`)
    if (found && ids.includes(found.id)) return row
  }
  return undefined
}

/** `hits` asks what is under the pointer after each step, which draws a frame built whole (a hit test flushes the window). */
function run(translate: boolean, rows: Rows, hits: boolean) {
  const { renderer, unmount, list } = open(rows)
  try {
    renderer.setScrollPatchEnabled(translate)
    renderer.scrollTo(list, 0, 200)
    rebuild(renderer)
    renderer.setInlineDraws(false)
    const before = { patched: renderer.getPatchCounters().patchedFrames, painted: renderer.getPaintedFrameCount(), scroll: scroll(renderer) }
    const seen: unknown[] = []
    const rowsUnder: Array<number | undefined> = []
    for (const [index, by] of STEPS.entries()) {
      wheel(renderer, by)
      if (hits) rowsUnder.push(rowUnder(renderer))
      seen.push({
        boxes: boxes(renderer),
        under: hits ? renderer.getElementsAt(X, Y) : null,
        picture: picture(renderer, `${rows}-${translate}-${hits}-${translate}-${index}`),
      })
    }
    const after = renderer.getPatchCounters()
    return {
      seen,
      rowsUnder,
      whole: renderer.getPaintedFrameCount() - before.painted,
      hoverPatches: after.patchedFrames - before.patched,
      scroll: after.scrollPatch,
      before: before.scroll,
      mismatches: renderer.getRetentionMismatches(),
    }
  } finally {
    unmount()
  }
}

describeNative("a wheel under a still pointer over rows with a hover style", { timeout: TIMEOUT }, () => {
  unverified("moves the rows by translates and paints the hover by patches, and shows what the frames built whole show", () => {
    const on = run(true, "paint", false)
    const off = run(false, "paint", false)
    expect(CROSSINGS, "the pointer crosses rows").toBeGreaterThanOrEqual(4)

    expect(on.scroll.frames - on.before.frames).toBe(STEPS.length)
    expect(on.scroll.patched - on.before.patched, "every wheel event is a translate").toBe(STEPS.length)
    expect(on.scroll.mispredicted).toBe(0)
    expect(on.scroll.held.Hover ?? 0, "a hover that only paints holds nothing").toBe(0)
    expect(on.scroll.hoverMatters).toBe(0)
    expect(on.scroll.hoverAsked, "the owner was asked about the crossings").toBeGreaterThanOrEqual(CROSSINGS)
    expect(on.hoverPatches, "each crossing is repainted by a patch").toBe(CROSSINGS)
    expect(on.whole, "no frame was built whole").toBe(0)
    expect(on.mismatches).toEqual([])

    expect(off.whole).toBeGreaterThan(0)
    expect(on.seen).toEqual(off.seen)
  })

  unverified("puts the pointer in the rows the frames built whole put it in", () => {
    const on = run(true, "paint", true)
    const off = run(false, "paint", true)
    expect(new Set(on.rowsUnder).size).toBeGreaterThan(2)
    expect(on.rowsUnder).toEqual(off.rowsUnder)
    expect(on.seen).toEqual(off.seen)
  })

  unverified("builds a frame whole for a hover that a listener hears", () => {
    const on = run(true, "heard", false)
    const off = run(false, "heard", false)
    expect(on.scroll.hoverMatters).toBeGreaterThan(0)
    expect(on.scroll.held.Hover).toBeGreaterThan(0)
    expect(on.seen).toEqual(off.seen)
  })

  it("is what a build gives under the retention verifier, registries included", () => {
    const { renderer, unmount, list } = open("paint")
    try {
      renderer.setRetainVerify(true)
      renderer.scrollTo(list, 0, 200)
      renderer.setInlineDraws(false)
      for (const [index, by] of STEPS.entries()) {
        // A frame that replays rows is built a second time under the verifier and shown as that build: the rows are built
        // again before each step so that the step has rows to move.
        rebuild(renderer)
        wheel(renderer, by)
        expect(renderer.getRetentionMismatches().join("\n"), `step ${index}`).toBe("")
      }
      expect(scroll(renderer).patched, "the steps are translates that were compared with a build").toBe(STEPS.length)
      expect(scroll(renderer).mispredicted).toBe(0)
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
      expect(renderer.getRetainedCounters().verified).toBeGreaterThan(0)
    } finally {
      unmount()
    }
  })
})
