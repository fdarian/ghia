// @ts-nocheck
/**
 * The hover under a pointer that stays follows a scroll on Chrome's schedule (Blink's `MarkHoverStateDirty`): a scroll that moves
 * rows under the pointer does not recompute it. It follows once the wheel has been quiet for 500 ms, 100 ms after a trackpad lift,
 * at the next frame after code wrote the offset, or at the next frame after a build that changed the page.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const X = 100
const Y = 50
const TIMEOUT = 120_000

type Kind = "div" | "list"

function Page({ kind, log, rows, extra }: { kind: Kind; log: string[]; rows: Map<number, any>; extra: number }) {
  const children = Array.from({ length: COUNT }, (_, index) => (
    <div
      key={index}
      testId={`row-${index}`}
      ref={(element) => {
        if (element) rows.set(index, element)
      }}
      onPointerEnter={() => log.push(`enter ${index}`)}
      onPointerLeave={() => log.push(`leave ${index}`)}
      style={{ height: ROW, flexShrink: 0, backgroundColor: "#223344", hover: { backgroundColor: "#664422" } }}
    >
      <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
    </div>
  ))
  const style = { width: 200, height: VIEWPORT, scrollbarWidth: "none" }
  const body =
    kind === "list" ? (
      <virtual-list testId="scroller" itemCount={COUNT} estimatedItemHeight={ROW} overdraw={0} style={style}>
        {children}
      </virtual-list>
    ) : (
      <div testId="scroller" style={{ ...style, overflowY: "scroll" }}>
        {children}
      </div>
    )
  return (
    <>
      {body}
      <div testId="extra" style={{ height: 0 }}>
        {extra}
      </div>
    </>
  )
}

function open(kind: Kind) {
  const log: string[] = []
  const rows = new Map<number, any>()
  const root = createTestRoot({ width: 300, height: 200 })
  const draw = (extra: number) => root.render(<Page kind={kind} log={log} rows={rows} extra={extra} />)
  draw(0)
  const renderer = root.renderer
  renderer.setA11yActive(false)
  renderer.dispatchNativeEvents()
  renderer.flush()
  const scroller = renderer.findByTestId("scroller")!.id
  // A list's rows are measured by showing each once, so that a wheel is a translate of them.
  if (kind === "list") {
    renderer.setScrollPatchEnabled(false)
    for (let scrolled = 0; scrolled <= COUNT * ROW - VIEWPORT; scrolled += 20) renderer.scrollTo(scroller, 0, scrolled)
    renderer.scrollTo(scroller, 0, 0)
    renderer.setScrollPatchEnabled(true)
  }
  // The hover is resynced from the draw that moved the rows, as a live window does, and a frame is a display-link frame.
  renderer.setHoverResyncByFrame(false)
  renderer.setInlineDraws(false)
  renderer.nativeSimulateMouseMove(X, Y)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
  renderer.drawFrame()
  const hovered = () => [...rows].filter(([, element]) => element.matches(":hover")).map(([index]) => index)
  const frames = (count = 3) => {
    for (let frame = 0; frame < count; frame += 1) {
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
    }
  }
  const wheel = (by: number, phase = "moved") => {
    renderer.dispatchScrollWheel(X, Y, 0, by, undefined, phase)
    frames(2)
  }
  const wait = (ms: number) => {
    renderer.advanceTime(ms)
    frames()
  }
  return { ...root, renderer, scroller, log, hovered, frames, wheel, wait, draw, rowUnder: () => Math.floor((Y + renderer.getScrollMetrics(scroller)[1]) / ROW) }
}

describeNative("the hover under a still pointer, over a scroll", { timeout: TIMEOUT }, () => {
  for (const kind of ["div", "list"] as const) {
    describe(`a ${kind === "div" ? "scroll container" : "virtual list"}`, () => {
      it("stays on the first row while a wheel runs, and moves to the row under the pointer 500 ms after the last tick", () => {
        const page = open(kind)
        try {
          expect(page.hovered()).toEqual([1])
          page.log.length = 0
          for (let tick = 0; tick < 6; tick += 1) {
            page.wheel(ROW)
            page.wait(50)
          }
          expect(page.rowUnder(), "the rows moved under the pointer").toBe(7)
          expect(page.hovered(), "the hover is where the last pointer input put it").toEqual([1])
          expect(page.log, "and nothing was emitted").toEqual([])

          page.wait(449)
          expect(page.hovered(), "499 ms after the last tick").toEqual([1])
          page.wait(1)
          expect(page.hovered(), "500 ms after the last tick").toEqual([7])
          expect(page.log, "the boundary events fire once").toEqual(["leave 1", "enter 7"])
          page.wait(600)
          expect(page.log).toEqual(["leave 1", "enter 7"])
        } finally {
          page.unmount()
        }
      })

      it("follows 100 ms after a trackpad lift that no momentum follows", () => {
        const page = open(kind)
        try {
          page.log.length = 0
          page.wheel(ROW, "started")
          page.wheel(ROW, "moved")
          page.wheel(0, "ended")
          expect(page.hovered()).toEqual([1])
          page.wait(99)
          expect(page.hovered(), "99 ms after the lift").toEqual([1])
          page.wait(1)
          expect(page.hovered(), "100 ms after the lift").toEqual([3])
          expect(page.log).toEqual(["leave 1", "enter 3"])
        } finally {
          page.unmount()
        }
      })

      it("waits for momentum that follows a lift, which runs the 500 ms again", () => {
        const page = open(kind)
        try {
          page.wheel(ROW, "started")
          page.wheel(0, "ended")
          page.wait(60)
          page.wheel(ROW, "moved")
          page.wait(400)
          expect(page.hovered(), "the lift's 100 ms is over, and momentum arrived within it").toEqual([1])
          page.wait(100)
          expect(page.hovered()).toEqual([3])
        } finally {
          page.unmount()
        }
      })

      it("follows at the next frame after a build that adds rows during the scroll", () => {
        const page = open(kind)
        try {
          page.wheel(ROW)
          page.wheel(ROW)
          expect(page.hovered(), "the wheel left it").toEqual([1])
          page.draw(1)
          page.frames()
          expect(page.hovered(), "a commit changed the page").toEqual([3])
        } finally {
          page.unmount()
        }
      })

      it("follows at the next frame after an instant write of scrollTop", () => {
        const page = open(kind)
        try {
          page.renderer.scrollTo(page.scroller, 0, 2 * ROW)
          page.frames()
          expect(page.hovered()).toEqual([3])
        } finally {
          page.unmount()
        }
      })

      it("follows a pointer that moved at once", () => {
        const page = open(kind)
        try {
          page.wheel(ROW)
          expect(page.hovered()).toEqual([1])
          page.renderer.dispatchMouseMove(X, Y + 1)
          page.frames()
          expect(page.hovered()).toEqual([2])
        } finally {
          page.unmount()
        }
      })
    })
  }
})
