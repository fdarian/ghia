// @ts-nocheck
/**
 * The hover under a pointer that stays follows a scroll on Chrome's schedule (Blink's `MarkHoverStateDirty`): a scroll that moves
 * rows under the pointer does not recompute it. It follows once the wheel has been quiet for 500 ms, 100 ms after a trackpad lift,
 * at the next frame after code scrolled (a write, `scrollIntoView`, a key; a smooth scroll when it ends), or at the next frame after
 * a build that changed the page or ran an animation of the layout. Motion that moves no box (a color, an opacity) changes nothing
 * under the pointer, so it does not make the hover follow.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { defineKeyframes } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

defineKeyframes("hover-after-scroll-pulse", { from: { opacity: 0.2 }, to: { opacity: 1 } })

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const X = 100
const Y = 50
const TIMEOUT = 120_000

type Kind = "div" | "list"

interface Options {
  /** The `transition` of every row, which runs while the pointer's row changes its background. */
  rowTransition?: string
  /** An infinite animation of the opacity of a box beside the scroller. */
  spinner?: boolean
  /** The property a box beside the scroller transitions over 5 s when `slide` changes: `width` is layout, `backgroundColor` is paint. */
  slides?: "width" | "backgroundColor"
  /** A second scroller, for a smooth scroll that another one makes. */
  second?: boolean
}

function Page({
  kind,
  log,
  rows,
  extra,
  slide,
  options,
}: {
  kind: Kind
  log: string[]
  rows: Map<number, any>
  extra: number
  slide: number
  options: Options
}) {
  const children = Array.from({ length: COUNT }, (_, index) => (
    <div
      key={index}
      testId={`row-${index}`}
      ref={(element) => {
        if (element) rows.set(index, element)
      }}
      onPointerEnter={() => log.push(`enter ${index}`)}
      onPointerLeave={() => log.push(`leave ${index}`)}
      style={{
        height: ROW,
        flexShrink: 0,
        backgroundColor: "#223344",
        hover: { backgroundColor: "#664422" },
        ...(options.rowTransition ? { transition: options.rowTransition } : {}),
      }}
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
      {options.spinner && (
        <div testId="spinner" style={{ width: 20, height: 10, backgroundColor: "#ffffff", animation: "hover-after-scroll-pulse 1s linear infinite" }} />
      )}
      {options.slides && (
        <div
          testId="slide"
          style={{
            height: 10,
            width: options.slides === "width" ? 20 + slide : 20,
            backgroundColor: options.slides === "backgroundColor" ? (slide === 0 ? "#ff0000" : "#0000ff") : "#ff0000",
            transition: `${options.slides === "width" ? "width" : "background-color"} 5s linear`,
          }}
        />
      )}
      {options.second && (
        <div testId="second" style={{ width: 50, height: 50, overflowY: "scroll", scrollbarWidth: "none" }}>
          {Array.from({ length: 20 }, (_, index) => (
            <div key={index} style={{ height: 25, flexShrink: 0 }} />
          ))}
        </div>
      )}
    </>
  )
}

function open(kind: Kind, options: Options = {}) {
  const log: string[] = []
  const rows = new Map<number, any>()
  const root = createTestRoot({ width: 300, height: 200 })
  const draw = (extra: number, slide = 0) => root.render(<Page kind={kind} log={log} rows={rows} extra={extra} slide={slide} options={options} />)
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
  return { ...root, renderer, scroller, rows, log, hovered, frames, wheel, wait, draw, rowUnder: () => Math.floor((Y + renderer.getScrollMetrics(scroller)[1]) / ROW) }
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

  for (const kind of ["div", "list"] as const) {
    describe(`motion that moves no box, over a ${kind === "div" ? "scroll container" : "virtual list"}`, () => {
      it("does not make the hover follow while a wheel runs over rows that transition their background", () => {
        const page = open(kind, { rowTransition: "background-color 5s linear" })
        try {
          expect(page.hovered()).toEqual([1])
          page.log.length = 0
          for (let tick = 0; tick < 3; tick += 1) {
            page.wheel(ROW)
            page.wait(50)
          }
          expect(page.rowUnder(), "the rows moved under the pointer").toBe(4)
          expect(page.hovered(), "the transition of the row the pointer is on is not a reason to follow").toEqual([1])
          expect(page.log).toEqual([])
          page.wait(449)
          expect(page.hovered()).toEqual([1])
          page.wait(1)
          expect(page.hovered(), "500 ms after the last tick").toEqual([4])
        } finally {
          page.unmount()
        }
      })

      it("does not make the hover follow while an opacity animation runs elsewhere on the page", () => {
        const page = open(kind, { spinner: true })
        try {
          page.log.length = 0
          for (let tick = 0; tick < 3; tick += 1) {
            page.wheel(ROW)
            page.wait(50)
          }
          expect(page.hovered(), "a spinner is not a reason to follow").toEqual([1])
          expect(page.log).toEqual([])
          page.wait(450)
          expect(page.hovered(), "500 ms after the last tick").toEqual([4])
        } finally {
          page.unmount()
        }
      })

      for (const [slides, follows] of [["backgroundColor", false], ["width", true]] as const) {
        it(`${follows ? "makes" : "does not make"} the hover follow while a transition of ${slides === "width" ? "a width" : "a color"} runs beside it`, () => {
          const page = open(kind, { slides })
          try {
            // The commit that starts the transition is a build that changed the page: the hover follows it. What is left is the
            // transition that runs for 5 s.
            page.wheel(ROW)
            page.draw(0, 100)
            page.frames()
            expect(page.hovered(), "the commit").toEqual([2])
            page.wheel(ROW)
            page.wait(50)
            expect(page.rowUnder()).toBe(3)
            expect(page.hovered(), follows ? "a width moves boxes: the hover follows each frame" : "a color moves nothing under the pointer").toEqual(
              follows ? [3] : [2],
            )
          } finally {
            page.unmount()
          }
        })
      }
    })
  }

  describe("a scroll that code makes", () => {
    it("follows at the next frame after scrollIntoView, which is not a smooth scroll", () => {
      const page = open("div")
      try {
        page.wheel(ROW)
        expect(page.hovered(), "the wheel left it").toEqual([1])
        page.rows.get(10).scrollIntoView({ block: "start" })
        page.frames()
        expect(page.rowUnder()).toBe(11)
        expect(page.hovered()).toEqual([11])
      } finally {
        page.unmount()
      }
    })

    it("follows at the next frame after a key scrolled", () => {
      const page = open("div")
      try {
        page.wheel(ROW)
        expect(page.hovered(), "the wheel left it").toEqual([1])
        page.renderer.scrollByKey("down", false)
        page.frames()
        expect(page.hovered()).toEqual([page.rowUnder()])
        expect(page.rowUnder()).toBeGreaterThan(2)
      } finally {
        page.unmount()
      }
    })

    it("follows when a smooth scrollTo ends, and not before", () => {
      const page = open("div")
      try {
        // A smooth scroll runs on the automation clock, which a test moves by hand.
        page.renderer.clockPause()
        const wait = (ms: number) => {
          page.renderer.clockFastForward(ms)
          page.wait(ms)
        }
        page.renderer.scrollTo(page.scroller, 0, 5 * ROW, "smooth")
        // The first frame starts the animation, at the time it is drawn.
        page.frames()
        wait(100)
        expect(page.hovered(), "the animation runs").toEqual([1])
        expect(page.renderer.getScrollMetrics(page.scroller)[1]).toBeGreaterThan(0)
        expect(page.renderer.getScrollMetrics(page.scroller)[1]).toBeLessThan(5 * ROW)
        wait(400)
        expect(page.renderer.getScrollMetrics(page.scroller)[1]).toBe(5 * ROW)
        expect(page.hovered(), "the animation ended").toEqual([6])
      } finally {
        page.unmount()
      }
    })

    it("follows an instant write at the next frame while another scroller scrolls smoothly", () => {
      const page = open("div", { second: true })
      try {
        const second = page.renderer.findByTestId("second")!.id
        page.renderer.scrollTo(second, 0, 400, "smooth")
        page.frames()
        page.renderer.scrollTo(page.scroller, 0, 2 * ROW)
        page.frames()
        expect(page.renderer.getScrollMetrics(second)[1], "the other one is still moving").toBeLessThan(400)
        expect(page.hovered(), "this write is over").toEqual([3])
      } finally {
        page.unmount()
      }
    })

    it("follows an instant write that comes in the same task as a smooth one", () => {
      const page = open("div", { second: true })
      try {
        const second = page.renderer.findByTestId("second")!.id
        page.wheel(ROW)
        page.renderer.scrollTo(page.scroller, 0, 2 * ROW)
        page.renderer.scrollTo(second, 0, 400, "smooth")
        page.frames()
        expect(page.hovered(), "the smooth write did not take the instant one back").toEqual([3])
      } finally {
        page.unmount()
      }
    })
  })
})
