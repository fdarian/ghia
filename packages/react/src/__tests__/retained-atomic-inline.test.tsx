// @ts-nocheck
/**
 * A list of rows that each hold a default `<button>`: an atomic inline (`inline-block` from the UA sheet) in the paragraph of
 * the row, which is in a block and not a flex box. An atomic inline does not keep the paragraph that hosts it, nor the rows and
 * scroller around it, from being recorded and replayed: a wheel over the scroller moves the recordings of the rows (a scroll
 * patch), and a hover paints the row it is over, with nothing else built. The picture, the boxes, what is under a point, the
 * selection and the text copied are what they are with retention off.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
// Under the verifier a frame that replays rows is built a second time whole and that build is the frame shown, so the counts of what a
// tick built and translated are not the ones of a run without it.
const unverified = it.skipIf(verifying)

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const TIMEOUT = 120_000
const VSYNC = 16

type Log = { clicks: number[] }
type Options = { count?: number; salt?: number; edited?: number; inline?: "button" | "block" | "grid" }

function Row({ index, log, salt, edited, inline }: { index: number; log: Log; salt: number; edited?: number; inline: Options["inline"] }) {
  return (
    <div
      testId={`row-${index}`}
      style={{
        position: "absolute",
        top: index * ROW,
        width: 190,
        height: ROW,
        fontSize: 14,
        lineHeight: "18px",
        color: "#ffffff",
        backgroundColor: (index + salt) % 2 === 0 ? "#223344" : "#334455",
        hover: { backgroundColor: "#664422" },
      }}
    >
      {`row ${index} `}
      {inline === "block" ? (
        <span testId={`box-${index}`} style={{ display: "inline-block", padding: 2, backgroundColor: "#445566" }}>{`box ${index}`}</span>
      ) : inline === "grid" ? (
        <span testId={`box-${index}`} style={{ display: "inline-grid", padding: 2, backgroundColor: "#445566" }}>{`grid ${index}`}</span>
      ) : (
        <button testId={`box-${index}`} onClick={() => log.clicks.push(index)}>{index === edited ? "A longer label" : `Open ${index}`}</button>
      )}
      {` end ${index}`}
    </div>
  )
}

function Page({ log, count = COUNT, salt = 0, edited, inline = "button" }: { log: Log } & Options) {
  return (
    <div testId="scroller" style={{ width: 200, height: VIEWPORT, overflowY: "auto", scrollbarWidth: "none" }}>
      <div testId="inner" style={{ position: "relative", width: "100%", height: count * ROW }}>
        {Array.from({ length: count }, (_, index) => (
          <Row key={index} index={index} log={log} salt={salt} edited={edited} inline={inline} />
        ))}
      </div>
    </div>
  )
}

function open(options: Options = {}, retain = true) {
  const log: Log = { clicks: [] }
  const root = createTestRoot({ width: 300, height: 200 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(<Page log={log} {...options} />)
  for (let frame = 0; frame < 3; frame++) {
    renderer.flush()
    renderer.dispatchNativeEvents()
  }
  renderer.setA11yActive(false)
  renderer.setInlineDraws(false)
  renderer.drawFrame()
  renderer.drawFrame()
  renderer.setRetainPlanning(retain)
  renderer.drawFrame()
  return { ...root, renderer, log, rerender: (next: Options) => root.render(<Page log={log} {...options} {...next} />) }
}

function tick(renderer, by: number, x = 100, y = 60) {
  renderer.clockAdvance(VSYNC)
  renderer.advanceTime(VSYNC)
  renderer.nativeSimulateScrollWheel(x, y, 0, by)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

function move(renderer, x: number, y: number) {
  renderer.clockAdvance(VSYNC)
  renderer.advanceTime(VSYNC)
  renderer.nativeSimulateMouseMove(x, y)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

let shots = 0
function picture(renderer): string {
  const file = `${SHOTS_DIR}/retained-atomic-inline-${process.pid}-${shots++}.png`
  fs.rmSync(file, { force: true })
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const type of ["div", "button", "span"]) {
    for (const element of renderer.findByType(type)) {
      const box = renderer.getElementBounds(element.id)
      if (box) out[String(element.id)] = box
    }
  }
  return out
}

const built = (renderer) => renderer.getBuildCounters().elementsBuilt

/** The centre of the box of row 1, and a point in the text before it: where a pointer finds what the rows hold. */
function targets(renderer): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const index of [0, 1, 2, 3]) {
    const box = renderer.findByTestId(`box-${index}`)
    const bounds = box && renderer.getElementBounds(box.id)
    if (bounds) out.push([bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], [bounds.x - 8, bounds.y + bounds.height / 2], [bounds.x + bounds.width + 8, bounds.y + bounds.height / 2])
  }
  return out
}

/** What a test observes of the page after a step. */
function seen(renderer, points: Array<[number, number]>) {
  return {
    boxes: boxes(renderer),
    under: [...points, ...targets(renderer)].map(([x, y]) => renderer.getElementsAt(x, y)),
    cursor: renderer.getCursor(),
    picture: picture(renderer),
  }
}

/** The rows' hover and wheel steps, each followed by what the page shows. */
function walk(retain: boolean, options: Options, points: Array<[number, number]>) {
  const opened = open(options, retain)
  const renderer = opened.renderer
  try {
    tick(renderer, 4)
    tick(renderer, -4)
    const frames: unknown[] = []
    const wheels: number[] = []
    const hovers: number[] = []
    for (const by of [3, 5, 8, -4, -9, 6, 2, 7]) {
      renderer.resetBuildCounters()
      tick(renderer, by)
      wheels.push(built(renderer))
      frames.push(seen(renderer, points))
    }
    for (const [x, y] of [[20, 10], [20, 50], [80, 90], [20, 5], [150, 30]] as Array<[number, number]>) {
      renderer.resetBuildCounters()
      move(renderer, x, y)
      hovers.push(built(renderer))
      frames.push(seen(renderer, points))
    }
    return { frames, wheels, hovers, scroll: renderer.getPatchCounters().scrollPatch, retained: renderer.getRetainedCounters() }
  } finally {
    opened.unmount()
  }
}

describeNative("rows that each hold an atomic inline", { timeout: TIMEOUT }, () => {
  const points: Array<[number, number]> = [[20, 10], [20, 50], [100, 99], [150, 30], [60, 20]]

  for (const inline of ["button", "block", "grid"] as const) {
    it(`show what a build shows, ${inline}`, () => {
      const on = walk(true, { inline }, points)
      const off = walk(false, { inline }, points)
      expect(on.frames).toEqual(off.frames)
      expect(on.retained.mismatches).toBe(0)
    })
  }

  for (const inline of ["button", "block", "grid"] as const) {
    unverified(`replay the rows and translate them under a wheel, building almost nothing, ${inline}`, () => {
      const on = walk(true, { inline }, points)
      const off = walk(false, { inline }, points)
      // A frame built whole builds every row (4 elements each, 60 rows); the rows are replayed and moved.
      expect(Math.min(...off.wheels.slice(1))).toBeGreaterThan(200)
      expect(Math.max(...on.wheels), `built per wheel tick: ${on.wheels}`).toBeLessThanOrEqual(8)
      expect(Math.max(...on.hovers), `built per hover: ${on.hovers}`).toBeLessThanOrEqual(24)
      expect(Math.min(...off.hovers)).toBeGreaterThan(200)
      expect(on.scroll.patched).toBeGreaterThanOrEqual(8)
      expect(on.scroll.held["NotRelocatable"]).toBe(0)
      expect(on.scroll.mispredicted).toBe(0)
      expect(on.retained.replays).toBeGreaterThan(0)
      expect(off.scroll.patched).toBe(0)
    })
  }

  /** The text copied by a drag from the first row to the third, and the selection a pointer reads back. */
  function select(retain: boolean, inline: Options["inline"]) {
    const opened = open({ inline }, retain)
    const renderer = opened.renderer
    try {
      tick(renderer, 4)
      tick(renderer, -4)
      tick(renderer, 7)
      renderer.clearSelection()
      renderer.nativeSimulateMouseDown(4, 12, 0)
      renderer.drawFrame()
      renderer.nativeSimulateMouseMove(180, 70)
      renderer.drawFrame()
      renderer.nativeSimulateMouseUp(180, 70, 0)
      renderer.drawFrame()
      const copied = renderer.getSelectedText()
      const picked = seen(renderer, points)
      return { copied, picked, mismatches: renderer.getRetainedCounters().mismatches }
    } finally {
      opened.unmount()
    }
  }

  for (const inline of ["button", "block"] as const) {
    it(`select the text around and in the boxes as a build does, ${inline}`, () => {
      const on = select(true, inline)
      const off = select(false, inline)
      expect(on.copied.length).toBeGreaterThan(10)
      expect(on.copied).toBe(off.copied)
      expect(on.picked).toEqual(off.picked)
      expect(on.mismatches).toBe(0)
    })
  }

  unverified("clicks the button of the row under the pointer after the rows were moved", () => {
    const clicked = (retain: boolean) => {
      const opened = open({ inline: "button" }, retain)
      const renderer = opened.renderer
      try {
        tick(renderer, 4)
        tick(renderer, -4)
        const rows: number[] = []
        for (const by of [13, 9, 30]) {
          tick(renderer, by)
          const visible = Array.from({ length: 6 }, (_, index) => renderer.getElementBounds(renderer.findByTestId(`box-${Math.floor(by / 2 / ROW) + index}`)?.id)).find(
            (bounds) => bounds && bounds.y >= 0 && bounds.y + bounds.height <= VIEWPORT,
          )
          expect(visible, "a button is in view").toBeDefined()
          const bounds = visible
          const before = opened.log.clicks.length
          renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
          rows.push(...opened.log.clicks.slice(before))
        }
        return { rows, patched: renderer.getPatchCounters().scrollPatch.patched }
      } finally {
        opened.unmount()
      }
    }
    const on = clicked(true)
    const off = clicked(false)
    expect(off.patched).toBe(0)
    expect(on.patched).toBeGreaterThan(0)
    expect(on.rows).toEqual(off.rows)
    expect(on.rows.length).toBe(3)
  })

  it("moves the focus along the buttons of the rows and shows the ring a build shows", () => {
    const focus = (retain: boolean) => {
      const opened = open({ inline: "button" }, retain)
      const renderer = opened.renderer
      try {
        const shown: unknown[] = []
        for (const key of ["Tab", "Tab", "Shift+Tab", "Tab"]) {
          renderer.simulateKeystrokes(key)
          renderer.drawFrame()
          shown.push(seen(renderer, points))
        }
        tick(renderer, 20)
        shown.push(seen(renderer, points))
        renderer.simulateKeystrokes("Tab")
        renderer.drawFrame()
        shown.push(seen(renderer, points))
        return { shown, mismatches: renderer.getRetainedCounters().mismatches }
      } finally {
        opened.unmount()
      }
    }
    const on = focus(true)
    expect(on.mismatches).toBe(0)
    expect(on.shown).toEqual(focus(false).shown)
  })

  it("a row whose button changes is built again and the others are replayed, as a build shows them", () => {
    const edit = (retain: boolean) => {
      const opened = open({ inline: "button" }, retain)
      const renderer = opened.renderer
      try {
        tick(renderer, 4)
        tick(renderer, -4)
        opened.rerender({ edited: 2 })
        renderer.drawFrame()
        renderer.drawFrame()
        return { shown: seen(renderer, points), mismatches: renderer.getRetainedCounters().mismatches }
      } finally {
        opened.unmount()
      }
    }
    const on = edit(true)
    expect(on.mismatches).toBe(0)
    expect(on.shown).toEqual(edit(false).shown)
  })
})
