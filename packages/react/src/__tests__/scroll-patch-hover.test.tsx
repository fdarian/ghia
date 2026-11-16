// @ts-nocheck
/**
 * A wheel under a pointer that stays moves the rows of a list under it, and the row it is over changes. A hover that only paints
 * (a row that takes another background colour) does not hold the translate (`Hover`): the rows are moved, and the tick the hover
 * follows the frame with repaints the two rows where the translate left them (`hoverMatters` stays 0, `patchedFrames` counts the
 * repaints, and no frame is built whole). The picture, the boxes and what is under a point are what they are with the translate off.
 * A hover a listener hears is a frame built whole still.
 *
 * A window that resyncs the hover from the draw a translate made (`setHoverResyncByFrame(false)`) has the tick of one wheel event
 * pending when the next wheel event arrives, so the draw of that event meets the tick and the notified list: the hover patch and
 * the translate are one draw, also when the rows the draw moves are ones a frame built whole put elsewhere than it recorded them: a
 * row so placed is a patch unit as a row a translate moved is, and its patch rewrites the recording the next translate moves.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"

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

/** `salt`: another tree for the same page, so that a frame drawn after a wheel is an edit, and the rows are replayed where it puts them. */
function Page({ rows, salt }: { rows: Rows; salt?: number }) {
  const list = (
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
  if (salt === undefined) return list
  return (
    <>
      {list}
      <div testId="salt" style={{ height: 0 }}>
        {salt}
      </div>
    </>
  )
}

function open(rows: Rows, salt?: number) {
  const root = createTestRoot({ width: 300, height: 200 })
  root.render(<Page rows={rows} salt={salt} />)
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

const hex = (rgb: number[]) => rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")
const HOVER = "664422"

/** The row of the list the pointer is over, from the boxes of the rows. */
function rowAtPointer(renderer): number {
  for (let row = 0; row < COUNT; row += 1) {
    const found = renderer.findByTestId(`row-${row}`)
    const box = found && renderer.getElementBounds(found.id)
    if (box && box.y <= Y && Y < box.y + box.height) return row
  }
  throw new Error("no row is under the pointer")
}

/**
 * The colour at the right edge (no text) of the middle of each row the list shows, by row, from the picture of the frame shown.
 */
function rowColours(renderer, name: string): Map<number, string> {
  const file = `${SHOTS_DIR}/scroll-patch-hover-${process.pid}-${name}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const pixels = readLogicalPixels(file, renderer)
  fs.rmSync(file, { force: true })
  const colours = new Map<number, string>()
  for (let row = 0; row < COUNT; row += 1) {
    const found = renderer.findByTestId(`row-${row}`)
    const box = found && renderer.getElementBounds(found.id)
    if (!box) continue
    const middle = Math.floor(box.y + box.height / 2)
    if (middle >= 0 && middle < VIEWPORT) colours.set(row, hex(pixels.at(190, middle).slice(0, 3)))
  }
  return colours
}

/** Wheels of one row under a pointer that stays: each puts another row under it. */
const LIVE_WHEELS = 20

describeNative("a wheel under a still pointer, in a window that resyncs the hover from the draw that moved the rows", { timeout: TIMEOUT }, () => {
  /** `built`: the rows that show are built where they stand before the wheels, so that none is a row a frame built whole replayed. */
  function live(built = true) {
    const page = open("paint")
    const renderer = page.renderer
    renderer.setHoverResyncByFrame(false)
    renderer.scrollTo(page.list, 0, 200)
    if (built) rebuild(renderer)
    renderer.setInlineDraws(false)
    return page
  }

  // The next wheel event arrives before the frame that the last one's hover tick asked for is drawn: one frame per event, and no
  // flush of the pending draw before an input (`nativeSimulateScrollWheel` flushes, a window does not).
  function wheels(renderer, count: number) {
    for (let wheeled = 0; wheeled < count; wheeled += 1) {
      renderer.dispatchScrollWheel(X, Y, 0, ROW)
      renderer.drawFrame()
    }
  }

  for (const built of [true, false]) {
    unverified(`draws the translate in the draw that meets the pending hover tick, and paints the hover where the pointer is${built ? "" : ", with no row built where it stands first"}`, () => {
      const { renderer, unmount } = live(built)
      try {
        const before = { painted: renderer.getPaintedFrameCount(), scroll: scroll(renderer) }
        wheels(renderer, LIVE_WHEELS)
        // The frame a window draws after the last wheel event: the tick of its crossing.
        renderer.drawFrame()
        const after = scroll(renderer)
        const whole = renderer.getPaintedFrameCount() - before.painted
        const translated = after.patched - before.scroll.patched

        expect(after.frames - before.scroll.frames, "every wheel event is classified").toBe(LIVE_WHEELS)
        expect(translated, `translates, with ${whole} frames built whole`).toBeGreaterThanOrEqual(LIVE_WHEELS - 2)
        expect(whole, "frames built whole").toBeLessThanOrEqual(2)
        expect(after.mispredicted).toBe(0)
        expect(renderer.getRetentionMismatches()).toEqual([])

        const under = rowAtPointer(renderer)
        const colours = rowColours(renderer, "live-end")
        expect(colours.get(under), "the row under the pointer has the hover colour").toBe(HOVER)
        const hovered = [...colours].filter(([, colour]) => colour === HOVER).map(([row]) => row)
        expect(hovered, "no other row has it").toEqual([under])
      } finally {
        unmount()
      }
    })

    it(`is what a build gives under the retention verifier${built ? "" : ", with no row built where it stands first"}`, () => {
      const { renderer, unmount } = live(built)
      try {
        renderer.setRetainVerify(true)
        wheels(renderer, LIVE_WHEELS)
        renderer.drawFrame()
        expect(renderer.getRetentionMismatches().join("\n")).toBe("")
        expect(renderer.getRetainedCounters().mismatches).toBe(0)
      } finally {
        unmount()
      }
    })
  }
})

const BASE = (row: number) => (row % 2 === 0 ? "223344" : "334455")

/** Every row that shows has the colour of its style, and the hover colour is the one under the pointer's alone. */
function expectPicture(renderer, name: string) {
  const under = rowAtPointer(renderer)
  const colours = rowColours(renderer, name)
  expect(colours.size, `${name}: rows show`).toBeGreaterThan(1)
  expect(colours.get(under), `${name}: the row under the pointer, ${under}`).toBe(HOVER)
  for (const [row, colour] of colours) if (row !== under) expect(colour, `${name}: row ${row}`).toBe(BASE(row))
}

describeNative("a row a frame built whole put elsewhere than it recorded it", { timeout: TIMEOUT }, () => {
  const declined = (renderer) => JSON.parse(renderer.getPatchCounters().unpatchable)["Hover:Relocated"] ?? 0

  // Each wheel crosses a row border (the pointer is at 50, the rows are 40 high, the list starts at 200): a frame built whole
  // moves the rows of the first step of each pair, and a translate those of the second.
  const STEPS_MOVED: Array<[boolean, number]> = [
    [false, 30],
    [true, 40],
    [false, 40],
    [true, -40],
    [false, -40],
    [true, 40],
    [true, 40],
  ]

  function walk(verify: boolean) {
    const { renderer, unmount, render, list } = open("paint", 0)
    try {
      renderer.scrollTo(list, 0, 200)
      rebuild(renderer)
      renderer.setInlineDraws(false)
      if (verify) renderer.setRetainVerify(true)
      let salt = 0
      const before = { patched: renderer.getPatchCounters().patchedFrames, relocated: declined(renderer), scroll: scroll(renderer), painted: renderer.getPaintedFrameCount() }
      let whole = 0
      for (const [index, [translate, by]] of STEPS_MOVED.entries()) {
        // Under the verifier a frame that replays rows is shown as its build: the rows are built again before each step.
        if (verify) rebuild(renderer)
        if (translate) {
          wheel(renderer, by)
        } else {
          // An edit in the draw of the wheel holds the translate: the frame is built whole and replays the rows where the wheel puts them.
          renderer.dispatchScrollWheel(X, Y, 0, by)
          salt += 1
          render(<Page rows="paint" salt={salt} />)
          renderer.flush()
          renderer.drawFrame()
          renderer.drawFrame()
          whole += 1
        }
        expect(renderer.getRetentionMismatches().join("\n"), `step ${index}`).toBe("")
        expectPicture(renderer, `moved-${verify}-${index}`)
      }
      const after = renderer.getPatchCounters()
      expect(declined(renderer) - before.relocated, "no hover is declined as relocated").toBe(0)
      return { patched: after.patchedFrames - before.patched, translates: after.scrollPatch.patched - before.scroll.patched, whole, painted: renderer.getPaintedFrameCount() - before.painted }
    } finally {
      unmount()
    }
  }

  unverified("is patched where it stands, and a translate after the patch moves what the patch painted", () => {
    const run = walk(false)
    expect(run.patched, "every crossing is a patch").toBeGreaterThanOrEqual(STEPS_MOVED.length)
    expect(run.translates, "the wheels no edit holds are translates").toBe(STEPS_MOVED.filter(([translate]) => translate).length)
    expect(run.painted, "the frames built whole are the wheels with an edit").toBe(run.whole)
  })

  it("is what a build gives under the retention verifier", () => {
    walk(true)
  })
})
