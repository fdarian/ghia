// @ts-nocheck
/**
 * A list scroll that changes which rows show is still a translate frame (`getPatchCounters().scrollPatch.membershipFrames`): the rows
 * that stay are moved, the rows that leave are taken out of the frame and out of what the page keeps of them (the boxes, the text,
 * the records), and the rows that come in are built as the list builds them. A programmatic write (`scrollTo`, `scrollTop = n`) takes
 * the same route as a wheel (`Window::note_list_scrolled`). The picture, the boxes, what is under a point and where a click goes are
 * what they are with the translate off, and a frame compared with a build (the retention verifier) is that build.
 *
 * Rows of 30 to 54 (every row has its own height) in a view of 600 (a row that stays moves by no more than half of that: the overscan its recording was made with), every row measured first: a row that has no measured size is a
 * whole frame (`Membership.unmeasured`), and so is a row in the overdraw that has none.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its rows
// are built, not replayed, so the next scroll has nothing to translate. The verified case below makes its own frames.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const COUNT = 80
const VIEW = 600
const GUTTER = 192
const TIMEOUT = 120_000

const height = (index: number) => 30 + ((index * 7) % 5) * 6
const top = (index: number) => Array.from({ length: index }, (_, row) => height(row)).reduce((sum, h) => sum + h, 0)
const LAST_TOP = top(COUNT) - VIEW

/** The rows that show at `scrolled` with no overdraw. */
function rowsAt(scrolled: number): number[] {
  return Array.from({ length: COUNT }, (_, row) => row).filter((row) => top(row) < scrolled + VIEW && top(row) + height(row) > scrolled)
}

/** The position that has `count` rows more than the ones at `scrolled` at the bottom, the last by one pixel. */
function downBy(scrolled: number, count: number): number {
  return top(rowsAt(scrolled).at(-1)! + count) - VIEW + 1
}

/** The position that has `count` rows more at the top, the last by one pixel. */
function upBy(scrolled: number, count: number): number {
  return top(rowsAt(scrolled)[0] - count + 1) - 1
}

type Page = { overdraw: number; log: number[] }

function Rows({ overdraw, log }: Page) {
  return (
    <div style={{ width: 300, height: 700, backgroundColor: "#ffffff" }}>
      <div style={{ height: 10, backgroundColor: "#eeeeee" }} />
      <virtual-list
        testId="list"
        itemCount={COUNT}
        estimatedItemHeight={40}
        overdraw={overdraw}
        style={{ width: 200, height: VIEW, scrollbarWidth: "none" }}
      >
        {Array.from({ length: COUNT }, (_, index) => (
          <div
            key={index}
            testId={`row-${index}`}
            onClick={() => log.push(index)}
            style={{
              width: 180,
              height: height(index),
              flexShrink: 0,
              backgroundColor: `hsl(${(index * 37) % 360}, 40%, ${index % 2 === 0 ? 40 : 55}%)`,
            }}
          >
            <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
          </div>
        ))}
      </virtual-list>
    </div>
  )
}

function open(overdraw: number, measured = true) {
  const log: number[] = []
  const root = createTestRoot({ width: 300, height: 700 })
  root.render(<Rows overdraw={overdraw} log={log} />)
  const renderer = root.renderer
  renderer.dispatchNativeEvents()
  renderer.flush()
  renderer.setA11yActive(false)
  const list = renderer.findByTestId("list")!.id
  if (measured) {
    // Every row measured, by showing every row once with the translate off.
    renderer.setScrollPatchEnabled(false)
    for (let scrolled = 0; scrolled <= LAST_TOP; scrolled += 20) renderer.scrollTo(list, 0, scrolled)
    renderer.scrollTo(list, 0, 0)
    renderer.setScrollPatchEnabled(true)
  }
  return { ...root, renderer, list, log }
}

/**
 * Builds every row that shows again, so that what the frame shown holds of them was recorded where they are now, and leaves the
 * frame shown as a frame that built them all (nothing replayed, so nothing is compared with a second build). The rows keep the size
 * they were measured at.
 */
function rebuild(renderer) {
  renderer.nativeSimulateMouseMove(GUTTER, 300)
  renderer.dispatchNativeEvents()
  renderer.setRetainPlanning(false)
  renderer.setRetainPlanning(true)
  renderer.flush()
}

function scroll(renderer) {
  return renderer.getPatchCounters().scrollPatch
}

function shotFile(name: string) {
  return `${SHOTS_DIR}/scroll-patch-membership-${process.pid}-${name}.png`
}

/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer, name: string): string {
  const file = shotFile(name)
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const element of [...renderer.findByType("div"), ...renderer.findByType("text")]) {
    const box = renderer.getElementBounds(element.id)
    if (box) out[String(element.testId ?? element.id)] = box
  }
  return out
}

const points: Array<[number, number]> = [[20, 20], [20, 180], [20, 350], [20, 520], [20, 605], [GUTTER, 300]]

/** What a test observes of the page after a step. */
function seen(renderer, name: string) {
  return {
    boxes: boxes(renderer),
    under: points.map(([x, y]) => renderer.getElementsAt(x, y)),
    cursor: renderer.getCursor(),
    picture: picture(renderer, name),
  }
}

/** A click on the middle of the part of each of the rows `rows` that shows, from the gutter and back to it. */
function click(renderer, list: number, log: number[], rows: number[]) {
  const view = renderer.getElementBounds(list)
  for (const row of rows) {
    const box = renderer.getElementBounds(renderer.findByTestId(`row-${row}`)!.id)
    expect(box, `row ${row} has a box`).toBeTruthy()
    const [from, to] = [Math.max(box.y, view.y), Math.min(box.y + box.height, view.y + view.height)]
    renderer.nativeSimulateClick(box.x + 20, (from + to) / 2)
    renderer.dispatchNativeEvents()
  }
  renderer.nativeSimulateMouseMove(GUTTER, 300)
  renderer.dispatchNativeEvents()
  // The frame after the pointer moved is the frame shown, with the pointer where it is.
  renderer.flush()
  return [...log]
}

/** Scrolls to `to` the way `how` says. */
type How = "scrollTo" | "wheel"

function move(renderer, list: number, how: How, from: number, to: number) {
  if (how === "scrollTo") {
    renderer.scrollTo(list, 0, to)
  } else {
    renderer.nativeSimulateScrollWheel(GUTTER, 300, 0, to - from)
    renderer.dispatchNativeEvents()
  }
}

type Step = { by: "down" | "up"; rows: number }

const steps: Step[] = [
  { by: "down", rows: 1 },
  { by: "down", rows: 2 },
  { by: "down", rows: 5 },
  { by: "up", rows: 1 },
  { by: "up", rows: 2 },
  { by: "up", rows: 5 },
  { by: "down", rows: 5 },
  { by: "up", rows: 1 },
]

/** The steps run on a page with the translate on or off; each is seen after, and its rows clicked. */
function run(translate: boolean, how: How, overdraw: number) {
  const opened = open(overdraw)
  const { renderer, unmount, list, log } = opened
  try {
    renderer.setScrollPatchEnabled(translate)
    let scrolled = 300
    renderer.scrollTo(list, 0, scrolled)
    rebuild(renderer)
    const frames: unknown[] = []
    const translated: boolean[] = []
    const entered: number[][] = []
    for (const [index, step] of steps.entries()) {
      const before = rowsAt(scrolled)
      const next = step.by === "down" ? downBy(scrolled, step.rows) : upBy(scrolled, step.rows)
      const counters = scroll(renderer)
      move(renderer, list, how, scrolled, next)
      const after = scroll(renderer)
      translated.push(after.membershipFrames > counters.membershipFrames)
      scrolled = next
      const shows = rowsAt(scrolled)
      const came = shows.filter((row) => !before.includes(row))
      entered.push(came)
      frames.push({ ...seen(renderer, `${translate}-${how}-${index}`), clicks: click(renderer, list, log, came) })
    }
    return { frames, translated, entered, counters: scroll(renderer), mismatches: renderer.getRetentionMismatches() }
  } finally {
    unmount()
  }
}

describeNative("a list scroll that changes which rows show", { timeout: TIMEOUT }, () => {
  describe.each([
    ["scrollTo", 0],
    ["scrollTo", 60],
    ["wheel", 0],
  ] as Array<[How, number]>)("by %s, overdraw %i", (how, overdraw) => {
    unverified("is a translate frame, and the picture, boxes, hits and clicks are what the build gives", () => {
      const on = run(true, how, overdraw)
      const off = run(false, how, overdraw)
      expect(off.counters.frames).toBe(0)
      expect(on.counters.mispredicted).toBe(0)
      expect(on.mismatches).toEqual([])
      if (overdraw === 0) {
        expect(on.translated, "every step that brings rows in and takes rows out is a translate with rows built").toEqual(steps.map(() => true))
        // A wheel moves by the delta it is given, which is the same position; the rows that come in are the ones built.
        expect(on.counters.rowsBuilt).toBeGreaterThanOrEqual(steps.reduce((sum, step) => sum + step.rows, 0))
        expect(on.counters.rowsRemoved).toBeGreaterThan(0)
      } else {
        // Rows in the overdraw that were measured are built too: what counts is that a step is not built whole when it can be moved.
        expect(on.counters.membershipFrames).toBeGreaterThan(0)
      }
      expect(on.counters.eligible).toBe(on.counters.patched + Object.values(on.counters.applyDeclines).reduce((a, b) => a + b, 0))
      expect(on.entered.flat().length).toBeGreaterThan(0)
      // Clicks reach the rows that came in, and no others.
      expect(on.frames.map((frame) => frame.clicks.length)).toEqual(
        on.frames.map((_, index) => on.frames.slice(0, index + 1).reduce((sum, __, step) => sum + on.entered[step].length, 0))
      )
      expect(on.frames).toEqual(off.frames)
    })
  })

  // Every row of the page is built in the frame that is not the scroll (`rebuild`), so
  // that nothing is replayed, no frame is built a second time under the verifier, and the rows of the frame shown can be moved. The
  // scroll that follows is compared with the frame built whole, the registries (the boxes and the text) included.
  it.each(["scrollTo", "wheel"] as How[])("is the frame built whole under the retention verifier, by %s", (how) => {
    const { renderer, unmount, list } = open(0)
    try {
      renderer.setRetainVerify(true)
      let scrolled = 300
      renderer.scrollTo(list, 0, scrolled)
      const before = scroll(renderer)
      const compared = renderer.getRetainedCounters().verified
      for (const [index, step] of steps.entries()) {
        rebuild(renderer)
        const next = step.by === "down" ? downBy(scrolled, step.rows) : upBy(scrolled, step.rows)
        move(renderer, list, how, scrolled, next)
        scrolled = next
        expect(renderer.getRetentionMismatches().join("\n"), `step ${index}`).toBe("")
      }
      const after = scroll(renderer)
      expect(after.membershipFrames - before.membershipFrames, "the scrolls are translates that were compared with a build").toBe(steps.length)
      expect(after.mispredicted).toBe(0)
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
      expect(renderer.getRetainedCounters().verified).toBeGreaterThan(compared)
    } finally {
      unmount()
    }
  })

  unverified("keeps a row that came in, left and came in again as the build has it", () => {
    const { renderer, unmount, list, log } = open(0)
    try {
      renderer.scrollTo(list, 0, 300)
      rebuild(renderer)
      const shows = rowsAt(300)
      // Down far enough that the first rows leave, and back, three times: each row that returns is built again.
      for (let round = 0; round < 3; round += 1) {
        renderer.scrollTo(list, 0, downBy(300, 3))
        renderer.scrollTo(list, 0, 300)
        rebuild(renderer)
      }
      expect(scroll(renderer).membershipFrames).toBeGreaterThanOrEqual(6)
      const gone = renderer.findByTestId(`row-${rowsAt(downBy(300, 3))[0] - 1}`)
      expect(gone).toBeTruthy()
      for (const row of shows) {
        expect(renderer.getElementBounds(renderer.findByTestId(`row-${row}`)!.id)).toBeTruthy()
      }
      expect(click(renderer, list, log, shows)).toEqual(shows)
      expect(renderer.getRetentionMismatches()).toEqual([])
    } finally {
      unmount()
    }
  })

  unverified("leaves no box for a row that left, as the build leaves none", () => {
    const { renderer, unmount, list } = open(0)
    try {
      renderer.scrollTo(list, 0, 300)
      rebuild(renderer)
      const first = rowsAt(300)[0]
      const id = renderer.findByTestId(`row-${first}`)!.id
      expect(renderer.getElementBounds(id)).toBeTruthy()
      const before = scroll(renderer).membershipFrames
      renderer.scrollTo(list, 0, downBy(300, 5))
      expect(scroll(renderer).membershipFrames).toBe(before + 1)
      expect(rowsAt(downBy(300, 5))).not.toContain(first)
      expect(renderer.getElementBounds(id)).toBeFalsy()
    } finally {
      unmount()
    }
  })
})

/** The rows with a box that shows in the list. */
function showing(renderer, list: number): number[] {
  const view = renderer.getElementBounds(list)
  return Array.from({ length: COUNT }, (_, row) => row).filter((row) => {
    const box = renderer.getElementBounds(renderer.findByTestId(`row-${row}`)!.id)
    return box && box.y < view.y + view.height && box.y + box.height > view.y
  })
}

/** Two thirds of the list's height: more than a row recorded where it showed can be moved by (half of it), and less than the rows measured past the ones that show. */
const DRIFT = 400
const FAR = Array.from({ length: 7 }, (_, step) => step * DRIFT)
const THERE_AND_BACK = [...FAR.slice(1), ...FAR.slice(0, -1).reverse()]

/**
 * A list whose rows are not measured (the list estimates each at 40), scrolled by steps of two thirds of its height through four of its
 * heights and back with no frame between built whole: the rows that stay move further than they were recorded for and are built where
 * they are, and the rows past the ones that show are measured by the scroll before the translate is classified.
 */
function drift(translate: boolean, how: How, overdraw: number) {
  const { renderer, unmount, list, log } = open(overdraw, false)
  try {
    renderer.setScrollPatchEnabled(translate)
    // The pointer is where it stays, so that no step is a hover change.
    renderer.nativeSimulateMouseMove(GUTTER, 300)
    renderer.dispatchNativeEvents()
    renderer.flush()
    let whole = 0
    const frames: unknown[] = []
    let scrolled = 0
    for (const [index, to] of THERE_AND_BACK.entries()) {
      const painted = renderer.getPaintedFrameCount()
      move(renderer, list, how, scrolled, to)
      whole += renderer.getPaintedFrameCount() - painted
      scrolled = to
      renderer.flush()
      frames.push({ ...seen(renderer, `drift-${translate}-${how}-${index}`), clicks: click(renderer, list, log, showing(renderer, list)) })
    }
    return { frames, whole, counters: scroll(renderer), mismatches: renderer.getRetentionMismatches() }
  } finally {
    unmount()
  }
}

describeNative("a list of rows with estimated heights scrolled through several of its heights", { timeout: TIMEOUT }, () => {
  describe.each([
    ["scrollTo", 450],
    ["wheel", 450],
  ] as Array<[How, number]>)("by %s, overdraw %i", (how, overdraw) => {
    unverified("builds the rows that come in and the rows that stay but moved too far, and is shown as the build shows it", () => {
      const on = drift(true, how, overdraw)
      const off = drift(false, how, overdraw)
      expect(on.mismatches).toEqual([])
      expect(on.counters.mispredicted).toBe(0)
      expect(on.counters.rowsRebuilt, JSON.stringify(on.counters)).toBeGreaterThan(0)
      expect(on.counters.rowsBuilt).toBeGreaterThanOrEqual(on.counters.rowsRebuilt)
      expect(on.counters.patched, JSON.stringify(on.counters)).toBe(THERE_AND_BACK.length)
      expect(on.counters.frames).toBe(THERE_AND_BACK.length)
      expect(on.whole, "no frame was built whole").toBe(0)
      expect(on.frames).toEqual(off.frames)
    })
  })

  it.each(["scrollTo", "wheel"] as How[])("is the frame built whole under the retention verifier, registries included, by %s", (how) => {
    const { renderer, unmount, list } = open(450, false)
    try {
      renderer.setRetainVerify(true)
      renderer.nativeSimulateMouseMove(GUTTER, 300)
      renderer.dispatchNativeEvents()
      renderer.flush()
      const before = scroll(renderer)
      const compared = renderer.getRetainedCounters().verified
      let scrolled = 0
      for (const [index, to] of THERE_AND_BACK.entries()) {
        move(renderer, list, how, scrolled, to)
        scrolled = to
        expect(renderer.getRetentionMismatches().join("\n"), `step ${index}`).toBe("")
      }
      const after = scroll(renderer)
      // The frame after a translate that was compared is a frame built whole (see the top of the verified case above): every second one.
      expect(after.patched - before.patched, JSON.stringify(after)).toBe(THERE_AND_BACK.length / 2)
      expect(after.rowsRebuilt - before.rowsRebuilt, "rows that stayed were built again, and compared").toBeGreaterThan(0)
      expect(after.mispredicted).toBe(0)
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
      expect(renderer.getRetainedCounters().verified).toBeGreaterThan(compared)
    } finally {
      unmount()
    }
  })
})
