/**
 * What an overlay scrollbar costs between a scroll and the end of its fade, in frames and not in time. The bar stays whole
 * for a second after the offset last moved and then fades over 200 ms: the second asks for no frame (one timer waits for
 * its end), and only the fade is drawn a frame at a time. A bar the pointer holds, and a classic one, ask for none either.
 *
 * Time moves as a display link would move it: `vsync` moves the clock of the window and the executor's together, then
 * delivers the frame callbacks and draws what is pending, and counts the frames that drew.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const VSYNC = 16
const FADE = 200
/** The frames a fade of 200 ms takes at one a vsync, and the one that ends it and the one before it. */
const FADE_FRAMES = Math.ceil(FADE / VSYNC) + 2

type Renderer = ReturnType<typeof createTestRoot>["renderer"]

const frameCount = (renderer: Renderer) => renderer.getPaintedFrameCount() + renderer.getPatchCounters().patchedFrames

/** A frame built whole: the view is told, as a commit does. */
function whole(renderer: Renderer) {
  renderer.flush()
  renderer.drawFrame()
}

/** A display-link frame `ms` later. Returns the frames it drew. */
function vsync(renderer: Renderer, ms = VSYNC) {
  const before = frameCount(renderer)
  renderer.clockAdvance(ms)
  renderer.advanceTime(ms)
  renderer.drawFrame()
  return frameCount(renderer) - before
}

/** The frames drawn by `count` vsyncs, one entry each. */
const run = (renderer: Renderer, count: number) => Array.from({ length: count }, () => vsync(renderer))

const sum = (frames: number[]) => frames.reduce((total, frames) => total + frames, 0)

let shots = 0
function shot(renderer: Renderer): Buffer {
  const file = `${SHOTS_DIR}/scrollbar-hold-${process.pid}-${shots++}.png`
  fs.rmSync(file, { force: true })
  renderer.captureScreenshot(file)
  // The capture notifies the view: the frame it asks for is its own and not the next vsync's.
  renderer.drawFrame()
  return fs.readFileSync(file)
}

const BLANK = { width: 300, height: 900 }
const scroller = (
  <div testId="scroller" style={{ width: 300, height: 150, flexShrink: 0, overflow: "auto" }}>
    <div style={BLANK} />
  </div>
)
const list = (
  <virtual-list testId="scroller" itemCount={30} estimatedItemHeight={30} style={{ width: 300, height: 150, flexShrink: 0 }}>
    {Array.from({ length: 30 }, (_, index) => (
      <div key={index} style={{ height: 30 }} />
    ))}
  </virtual-list>
)

async function mount(content: React.ReactNode) {
  const root = createTestRoot({ width: 800, height: 500 })
  const renderer = root.renderer
  renderer.clockPause()
  root.render(<div style={{ display: "flex", flexDirection: "column" }}>{content}</div>)
  for (let frame = 0; frame < 6; frame++) {
    renderer.flush()
    renderer.dispatchNativeEvents()
    await new Promise((resolve) => setTimeout(resolve, 8))
  }
  renderer.setInlineDraws(false)
  whole(renderer)
  whole(renderer)
  return { root, renderer, id: renderer.findByTestId("scroller")!.id }
}

for (const [name, content] of [
  ["a scroller", scroller],
  ["a virtual list", list],
] as const) {
  describeNative(`the overlay scrollbar of ${name}`, { timeout: 120_000 }, () => {
    it("takes no frame for the hold, a few for the fade, and is gone after it", async () => {
      const page = await mount(content)
      try {
        const renderer = page.renderer
        const bare = shot(renderer)
        renderer.scrollTo(page.id, 0, 100)
        const scrolling = frameCount(renderer)
        whole(renderer)
        expect(frameCount(renderer) - scrolling, "the frame the scroll needs").toBeGreaterThan(0)
        const lit = shot(renderer)
        expect(lit.equals(bare), "the bar shows").toBe(false)

        // 62 vsyncs are 992 ms: the hold has not ended.
        const hold: number[] = []
        for (let index = 0; index < 62; index++) {
          hold.push(vsync(renderer))
          if (index === 30) expect(shot(renderer).equals(lit), "whole in the middle of the hold").toBe(true)
        }
        expect(sum(hold), "frames drawn while the bar holds").toBe(0)
        expect(shot(renderer).equals(lit), "whole at the end of the hold").toBe(true)

        const fade = run(renderer, 4)
        expect(fade[0], "the end of the hold is a frame").toBe(1)
        expect(shot(renderer).equals(lit), "the fade has begun").toBe(false)
        expect(shot(renderer).equals(bare), "and is not over").toBe(false)
        fade.push(...run(renderer, 20))
        expect(sum(fade), "a frame for each vsync of 200 ms and the two that end it").toBeLessThanOrEqual(FADE_FRAMES)
        expect(shot(renderer).equals(bare), "gone").toBe(true)
        expect(sum(run(renderer, 100)), "and nothing is drawn after it").toBe(0)
      } finally {
        page.root.unmount()
      }
    })

    it("holds again for a second from a scroll that comes in the hold", async () => {
      const page = await mount(content)
      try {
        const renderer = page.renderer
        const bare = shot(renderer)
        renderer.scrollTo(page.id, 0, 100)
        whole(renderer)
        expect(sum(run(renderer, 37)), "592 ms into the first hold").toBe(0)
        renderer.scrollTo(page.id, 0, 200)
        whole(renderer)
        const second = shot(renderer)
        expect(second.equals(bare)).toBe(false)
        // 592 + 976 ms is past the end of the first hold.
        expect(sum(run(renderer, 61)), "976 ms into the second").toBe(0)
        expect(shot(renderer).equals(second), "still whole").toBe(true)
        const fade = run(renderer, 30)
        expect(sum(fade)).toBeGreaterThan(0)
        expect(sum(fade)).toBeLessThanOrEqual(FADE_FRAMES)
        expect(shot(renderer).equals(bare), "gone").toBe(true)
      } finally {
        page.root.unmount()
      }
    })

    it("stays, with no frame, under the pointer, and holds for a second from where the pointer leaves", async () => {
      const page = await mount(content)
      try {
        const renderer = page.renderer
        const bare = shot(renderer)
        renderer.scrollTo(page.id, 0, 100)
        whole(renderer)
        renderer.nativeSimulateMouseMove(295, 30)
        renderer.drawFrame()
        // It thickens over 150 ms.
        expect(sum(run(renderer, 12)), "a frame for each vsync it thickens").toBeGreaterThan(0)
        const held = shot(renderer)
        expect(held.equals(bare)).toBe(false)
        expect(sum(run(renderer, 300)), "4.8 s under the pointer").toBe(0)
        expect(shot(renderer).equals(held), "still there").toBe(true)

        renderer.nativeSimulateMouseMove(600, 400)
        renderer.drawFrame()
        // It thins over 150 ms, then holds for a second from the move.
        run(renderer, 12)
        expect(sum(run(renderer, 40)), "the hold from where the pointer left").toBe(0)
        const fade = run(renderer, 40)
        expect(sum(fade)).toBeGreaterThan(0)
        expect(sum(fade)).toBeLessThanOrEqual(FADE_FRAMES)
        expect(shot(renderer).equals(bare), "gone").toBe(true)
      } finally {
        page.root.unmount()
      }
    })

    it("stays, with no frame, under a held thumb", async () => {
      const page = await mount(content)
      try {
        const renderer = page.renderer
        renderer.scrollTo(page.id, 0, 100)
        whole(renderer)
        renderer.nativeSimulateMouseMove(295, 30)
        renderer.drawFrame()
        run(renderer, 12)
        renderer.nativeSimulateMouseDown(295, 30)
        renderer.drawFrame()
        run(renderer, 12)
        const held = shot(renderer)
        expect(sum(run(renderer, 200)), "3.2 s with the button down").toBe(0)
        expect(shot(renderer).equals(held)).toBe(true)
        renderer.nativeSimulateMouseUp(295, 30)
        renderer.drawFrame()
      } finally {
        page.root.unmount()
      }
    })
  })
}

describeNative("the classic scrollbar of a scroller", { timeout: 120_000 }, () => {
  it("never fades and asks for no frame", async () => {
    const page = await mount(scroller)
    try {
      const renderer = page.renderer
      renderer.setScrollbarStyle("classic")
      whole(renderer)
      whole(renderer)
      renderer.scrollTo(page.id, 0, 100)
      whole(renderer)
      whole(renderer)
      const lit = shot(renderer)
      expect(sum(run(renderer, 200)), "3.2 s").toBe(0)
      expect(shot(renderer).equals(lit)).toBe(true)
    } finally {
      page.root.unmount()
    }
  })
})
