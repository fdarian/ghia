// @ts-nocheck
/**
 * A page that moves every root with each frame (a pan, where the owner of the offset is the page and not a scroller)
 * replays none of what a frame skips: each root is built late, which costs more than building it in the frame. The
 * gate narrows retention to a sample of the roots while that lasts, and opens again once the page stands still.
 *
 * Under GPUIX_RETAIN_VERIFY=1 the gate judges nothing (every root is taken, since replay is what is checked), so the
 * counts are not read there, only that the frames agree with a build.
 */
import React from "react"
import { expect, it } from "vitest"
import { Card, describeNative, setup, verifying } from "./retained-harness.js"

const CARDS = 160
const retained = process.env.GPUIX_RETAIN_OFF === undefined

const PanPage = ({ x, clock = 0 }: { x: number; clock?: number }) => (
  <div testId="page" style={{ width: 640, height: 480, overflow: "hidden" }}>
    <div style={{ height: 20 }}>
      <text>{`clock ${clock}`}</text>
    </div>
    <div style={{ position: "absolute", left: -x, top: 20, width: 9000, display: "flex", flexWrap: "wrap", gap: 8 }}>
      {Array.from({ length: CARDS }, (_, index) => (
        <Card key={index} index={index} />
      ))}
    </div>
  </div>
)

const emptyWindow = () => {
  const view = setup(<div />)
  view.renderer.setInlineDraws(false)
  return view
}

const frame = (view, render?: React.ReactElement) => {
  const { renderer } = view
  const before = renderer.getRetainedCounters()
  if (render) view.render(render)
  renderer.drawFrame()
  const after = renderer.getRetainedCounters()
  return {
    hits: after.hits - before.hits,
    replays: after.replays - before.replays,
    lazy: after.lazyBuilds - before.lazyBuilds,
  }
}

describeNative("the retention gate", () => {
  it("holds skipping back while a pan moves every root, and comes back when the page stands still", () => {
    const view = emptyWindow()
    try {
      frame(view, <PanPage x={0} />)
      frame(view, <PanPage x={0} />)
      const still = frame(view, <PanPage x={0} />)
      if (retained && !verifying) expect(still.replays, "every card replays on a page that stands still").toBeGreaterThanOrEqual(CARDS)

      const pan = []
      for (let step = 1; step <= 14; step++) pan.push(frame(view, <PanPage x={step * 24} />))
      if (retained && !verifying) {
        // The first frames of the pan skip every card and build them late; the gate has judged them by the third.
        const roots = pan[0].hits
        expect(roots, "the first frame of the pan skips every root").toBeGreaterThanOrEqual(CARDS)
        expect(pan[0].lazy, "and builds them late, as it cannot replay them").toBeGreaterThan(roots / 2)
        for (const settled of pan.slice(2)) {
          expect(settled.hits, "a closed gate skips a sample of the roots").toBeLessThanOrEqual(roots / 4)
          expect(settled.lazy).toBeLessThanOrEqual(roots / 4)
        }
      }
      view.expectWhatABuildShows("pan")

      const stop = []
      for (let index = 0; index < 4; index++) stop.push(frame(view, <PanPage x={14 * 24} />))
      if (retained && !verifying) {
        const last = stop.at(-1)
        expect(last.hits, "the page stands still: every card is skipped again").toBeGreaterThanOrEqual(CARDS)
        expect(last.replays, "and replayed").toBeGreaterThanOrEqual(CARDS)
        expect(last.lazy).toBe(0)
      }
      view.expectWhatABuildShows("still")
      view.finish(retained)
    } finally {
      view.unmount()
    }
  })

  it("stays open on a page whose frames replay what they skip", () => {
    const view = emptyWindow()
    try {
      frame(view, <PanPage x={0} clock={0} />)
      frame(view, <PanPage x={0} clock={1} />)
      for (let clock = 2; clock < 14; clock++) {
        const ticked = frame(view, <PanPage x={0} clock={clock} />)
        if (retained && !verifying) {
          expect(ticked.hits, "a clock ticking beside the cards changes none of them").toBeGreaterThanOrEqual(CARDS)
          expect(ticked.replays).toBeGreaterThanOrEqual(CARDS)
        }
      }
      view.expectWhatABuildShows("clock")
      view.finish(retained)
    } finally {
      view.unmount()
    }
  })

  it("closes again when the pan starts again", () => {
    const view = emptyWindow()
    try {
      frame(view, <PanPage x={0} />)
      frame(view, <PanPage x={0} />)
      for (let round = 0; round < 2; round++) {
        for (let step = 1; step <= 6; step++) frame(view, <PanPage x={step * 24} />)
        frame(view, <PanPage x={144} />)
        frame(view, <PanPage x={144} />)
        frame(view, <PanPage x={144} />)
        const still = frame(view, <PanPage x={144} />)
        if (retained && !verifying) expect(still.replays).toBeGreaterThanOrEqual(CARDS)
        const moving = [1, 2, 3, 4, 5].map((step) => frame(view, <PanPage x={144 - step * 24} />))
        if (retained && !verifying) expect(moving.at(-1).hits).toBeLessThanOrEqual(still.hits / 2)
        frame(view, <PanPage x={24} />)
        frame(view, <PanPage x={24} />)
        frame(view, <PanPage x={24} />)
        frame(view, <PanPage x={0} />)
      }
      view.expectWhatABuildShows("again")
      view.finish(retained)
    } finally {
      view.unmount()
    }
  })
})
