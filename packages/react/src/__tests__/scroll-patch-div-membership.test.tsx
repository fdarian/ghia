// @ts-nocheck
/**
 * A wheel step over a `div` scroller whose commit only takes rows out of it is drawn as a translate that takes them out of the frame
 * (`scrollPatch.rowsRemoved`), as the rows of a `<virtual-list>` that leave are: TanStack Virtual's scroll handler renders the rows the
 * new offset needs, and the ones that went out of its window are removed. The rows that leave are out of the picture, of the boxes (a
 * removed node reports no box), of what is under a point and of the clicks, and all of it is what the same steps give with the translate
 * off (`setScrollPatchEnabled(false)`).
 *
 * What the commit must not do besides taking the rows out is move or restyle what stays, so the rows that leave are the ones that take
 * no room: absolute boxes (placed by `top` or by a `transform`). Rows in the flow, or a commit that also changes another element, are
 * frames built whole, which the last cases pin.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its rows
// are built, not replayed, so there is nothing to translate after it. The cases that count translates skip there, and the ones that
// follow compare with the verifier on.
const unverified = it.skipIf(verifying)

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const ROW_WIDTH = 150
const TIMEOUT = 120_000
const VSYNC = 16

type Layout = "absolute" | "transform" | "flow"

type Log = { clicks: number[]; nodes: Record<number, unknown> }

type Options = { removed?: number[]; tint?: boolean; hover?: boolean }

function Page({ log, layout, removed = [], tint, hover }: { log: Log; layout: Layout } & Options) {
  const rows = Array.from({ length: COUNT }, (_, index) => index)
    .filter((index) => !removed.includes(index))
    .map((index) => (
      <div
        key={index}
        testId={`row-${index}`}
        ref={(instance) => {
          if (instance !== null) log.nodes[index] = instance
        }}
        onClick={() => log.clicks.push(index)}
        style={{
          position: layout === "flow" ? undefined : "absolute",
          top: layout === "absolute" ? index * ROW : layout === "transform" ? 0 : undefined,
          ...(layout === "transform" ? { transform: `translateY(${index * ROW}px)` } : {}),
          width: ROW_WIDTH,
          height: ROW,
          flexShrink: 0,
          backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
          ...(hover ? { hover: { backgroundColor: "#664422" } } : {}),
        }}
      >
        <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
      </div>
    ))
  return (
    <div testId="scroller" style={{ width: 200, height: VIEWPORT, overflowY: "auto", scrollbarWidth: "none", ...(tint ? { backgroundColor: "#101820" } : {}) }}>
      {layout !== "flow" ? (
        <div testId="inner" style={{ position: "relative", width: "100%", height: COUNT * ROW }}>
          {rows}
        </div>
      ) : (
        rows
      )}
    </div>
  )
}

function open(translate: boolean, layout: Layout, options: Options = {}) {
  const log: Log = { clicks: [], nodes: {} }
  const root = createTestRoot({ width: 300, height: 200 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(<Page log={log} layout={layout} {...options} />)
  for (let frame = 0; frame < 3; frame++) {
    renderer.flush()
    renderer.dispatchNativeEvents()
  }
  renderer.setA11yActive(false)
  renderer.setInlineDraws(false)
  renderer.drawFrame()
  renderer.drawFrame()
  // A wheel and its way back record the rows and put them elsewhere.
  renderer.setScrollPatchEnabled(translate)
  return { ...root, renderer, log }
}

let shots = 0
/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer): string {
  const file = `${SHOTS_DIR}/scroll-patch-div-membership-${process.pid}-${shots++}.png`
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
    if (box) out[String(element.id)] = box
  }
  return out
}

const scroll = (renderer) => renderer.getPatchCounters().scrollPatch

const points: Array<[number, number]> = [[20, 10], [20, 50], [20, 90], [180, 60]]

/** What a test observes of the page after a step: the boxes, the offset, what is under the points, the picture, and what a node that left reports. */
function seen(opened, left: number[]) {
  const renderer = opened.renderer
  const scroller = renderer.findByTestId("scroller")
  return {
    boxes: boxes(renderer),
    scrollOffset: renderer.getScrollOffset(scroller.id),
    under: points.map(([x, y]) => renderer.getElementsAt(x, y)),
    cursor: renderer.getCursor(),
    picture: picture(renderer),
    gone: left.map((index) => {
      const box = opened.log.nodes[index].getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }),
  }
}

type Step = { by: number; remove?: number[] }

/**
 * Each step is a wheel, and the commit that the scroll handler of a virtualizer makes with it: `remove` are the rows that stop being
 * rendered, which come out of the tree before the frame of the step is drawn.
 */
function run(translate: boolean, layout: Layout, steps: Step[], options: Options = {}) {
  const opened = open(translate, layout, options)
  const renderer = opened.renderer
  try {
    renderer.nativeSimulateMouseMove(180, 60)
    renderer.dispatchNativeEvents()
    renderer.drawFrame()
    const wheel = (by: number) => {
      renderer.clockAdvance(VSYNC)
      renderer.advanceTime(VSYNC)
      renderer.nativeSimulateScrollWheel(180, 60, 0, by)
      renderer.dispatchNativeEvents()
    }
    wheel(4)
    renderer.drawFrame()
    wheel(-4)
    renderer.drawFrame()
    const before = scroll(renderer)
    const removed: number[] = []
    const frames: unknown[] = []
    const translated: boolean[] = []
    for (const step of steps) {
      const patched = scroll(renderer).patched
      wheel(step.by)
      if (step.remove) {
        removed.push(...step.remove)
        opened.render(<Page log={opened.log} layout={layout} removed={removed} {...options} />)
      }
      renderer.drawFrame()
      translated.push(scroll(renderer).patched > patched)
      frames.push(seen(opened, removed))
    }
    // The click on a row that is still there, and on the place of one that left.
    const clicks: number[] = []
    for (const [x, y] of [[20, 50], [20, 90]]) {
      const before = opened.log.clicks.length
      renderer.nativeSimulateClick(x, y)
      clicks.push(...opened.log.clicks.slice(before))
    }
    return { frames, translated, counters: scroll(renderer), before, clicks, mismatches: renderer.getRetentionMismatches(), removed }
  } finally {
    opened.unmount()
  }
}

/** The rows that leave are in the clip (rows 1 and 2 at the offset the steps reach) and in the overscan under it. */
const steps: Step[] = [
  { by: 3 },
  { by: 5, remove: [9] },
  { by: 8 },
  { by: -4, remove: [1] },
  { by: 6, remove: [2, 4] },
  { by: 2 },
  { by: 7, remove: [12] },
]

describeNative("a wheel step over a div scroller whose commit only takes rows out of it", { timeout: TIMEOUT }, () => {
  for (const layout of ["absolute", "transform"] as const) {
    unverified(`is a translate with the rows taken out, over ${layout} rows`, () => {
      const on = run(true, layout, steps)
      const off = run(false, layout, steps)
      expect(off.counters.frames).toBe(0)
      expect(on.counters.mispredicted).toBe(0)
      expect(on.translated, "every step is a translate: the ones with a commit take the rows out").toEqual(steps.map(() => true))
      expect(on.counters.membershipFrames - on.before.membershipFrames).toBe(4)
      expect(on.counters.rowsRemoved - on.before.rowsRemoved).toBe(5)
      expect(on.counters.rowsBuilt - on.before.rowsBuilt, "nothing came in").toBe(0)
      expect(on.counters.held.Edited ?? 0, "a commit that took rows out is no edit").toBe(0)
      // The picture, the boxes, what is under the points, the cursor, the offset and what a node that left reports.
      expect(on.frames).toEqual(off.frames)
      expect(on.clicks).toEqual(off.clicks)
      expect(on.frames.at(-1).gone.length).toBe(5)
      expect(on.frames.at(-1).gone.every((box) => box.width === 0 && box.height === 0), "a node that left has no box").toBe(true)
    })
  }

  unverified("takes a row out from under the pointer", () => {
    const hover = (translate: boolean) => {
      const opened = open(translate, "absolute", { hover: true })
      const renderer = opened.renderer
      try {
        renderer.nativeSimulateMouseMove(20, 50)
        renderer.dispatchNativeEvents()
        renderer.drawFrame()
        renderer.drawFrame()
        for (const by of [4, -4]) {
          renderer.clockAdvance(VSYNC)
          renderer.nativeSimulateScrollWheel(20, 50, 0, by)
          renderer.dispatchNativeEvents()
          renderer.drawFrame()
        }
        renderer.clockAdvance(VSYNC)
        renderer.nativeSimulateScrollWheel(20, 50, 0, 3)
        renderer.dispatchNativeEvents()
        opened.render(<Page log={opened.log} layout="absolute" removed={[1]} hover />)
        renderer.drawFrame()
        const during = { under: renderer.getElementsAt(20, 50), picture: picture(renderer) }
        renderer.advanceTime(500)
        renderer.dispatchNativeEvents()
        for (let frame = 0; frame < 3; frame++) renderer.drawFrame()
        return { patched: scroll(renderer).patched, during, ended: { under: renderer.getElementsAt(20, 50), picture: picture(renderer) } }
      } finally {
        opened.unmount()
      }
    }
    const on = hover(true)
    const off = hover(false)
    expect(on.patched).toBeGreaterThan(0)
    expect(on.during).toEqual(off.during)
    expect(on.ended).toEqual(off.ended)
  })

  it("draws the same under the verifier, and the verifier finds no difference", () => {
    for (const layout of ["absolute", "transform"] as const) {
      const on = run(true, layout, steps)
      const off = run(false, layout, steps)
      expect(on.frames).toEqual(off.frames)
      expect(on.mismatches.join("\n")).toBe("")
      expect(on.counters.rowsRemoved, "the verifier compared a translate that took rows out").toBeGreaterThan(0)
    }
  })

  unverified("is a frame built whole over rows in the flow, which a row that leaves moves the rest of", () => {
    const flow: Step[] = [{ by: 3 }, { by: 5, remove: [1] }, { by: 8 }]
    const on = run(true, "flow", flow)
    const off = run(false, "flow", flow)
    expect(on.translated.slice(0, 2), "the step with the commit is a frame built whole").toEqual([true, false])
    expect(on.counters.rowsRemoved - on.before.rowsRemoved).toBe(0)
    expect(on.counters.reasons.Edited).toBeGreaterThan(0)
    expect(on.frames).toEqual(off.frames)
  })

  unverified("is a frame built whole when the commit changes another element as well", () => {
    const opened = open(true, "absolute")
    const renderer = opened.renderer
    try {
      renderer.nativeSimulateMouseMove(180, 60)
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      for (const by of [4, -4]) {
        renderer.clockAdvance(VSYNC)
        renderer.nativeSimulateScrollWheel(180, 60, 0, by)
        renderer.dispatchNativeEvents()
        renderer.drawFrame()
      }
      const before = scroll(renderer)
      renderer.clockAdvance(VSYNC)
      renderer.nativeSimulateScrollWheel(180, 60, 0, 5)
      renderer.dispatchNativeEvents()
      // The scroller gets a background in the commit that takes the row out.
      opened.render(<Page log={opened.log} layout="absolute" removed={[9]} tint />)
      renderer.drawFrame()
      const after = scroll(renderer)
      expect(after.patched - before.patched).toBe(0)
      expect(after.reasons.Edited - before.reasons.Edited).toBe(1)
      expect(after.rowsRemoved - before.rowsRemoved).toBe(0)
    } finally {
      opened.unmount()
    }
  })
})
