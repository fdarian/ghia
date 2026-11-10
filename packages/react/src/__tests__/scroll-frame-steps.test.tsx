// `onScroll` runs in the steps before the frame that paints the offset, and what its handler changes is in that
// frame: a window that follows the scroll offset shows the rows of the offset it is painted at, with no frame between.
import { useState } from "react"
import { describe, expect, it } from "vitest"
import type { ScrollEvent } from "@ghia/native/host"
import type { EventPayload } from "@ghia/native"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

/** A scroller whose sticky label shows the offset its last `onScroll` event reported. */
function Page(props: { behavior?: "smooth"; onScroll?: (event: ScrollEvent) => void }) {
  const [reported, setReported] = useState(0)
  return (
    <div
      testId="scroller"
      style={{ width: 200, height: 100, overflow: "auto", scrollBehavior: props.behavior }}
      onScroll={(event) => {
        props.onScroll?.(event)
        setReported(Math.round(event.scrollTop))
      }}
    >
      <div style={{ position: "sticky", top: 0, height: 20 }}>{`offset ${reported}`}</div>
      <div style={{ height: 1000 }} />
    </div>
  )
}

function setup(props: Parameters<typeof Page>[0] = {}, clock: "paused" | "running" = "paused") {
  const root = createTestRoot()
  const renderer = root.renderer
  if (clock === "paused") renderer.clockPause()
  renderer.setInlineDraws(false)
  root.render(<Page {...props} />)
  renderer.drawFrame()
  renderer.dispatchNativeEvents()
  const id = renderer.findByTestId("scroller")!.id
  return {
    ...root,
    id,
    /** Draws the next frame and says what it painted, and how many draws that took. */
    frame() {
      const before = renderer.getPaintedFrameCount()
      renderer.drawFrame()
      const painted = renderer.getPaintedText().find((text) => text.startsWith("offset "))
      const frames = renderer.getPaintedFrameCount() - before
      return { painted, frames }
    },
    top: () => Math.round(renderer.getScrollOffset(id)![1]),
  }
}

describeNative("the frame steps of a scroll", () => {
  it("paint what a wheel scroll's handler changed in the frame that paints the new offset", () => {
    const { renderer, frame, id, top, unmount } = setup()
    try {
      renderer.nativeSimulateScrollWheel(100, 50, 0, 40)
      const { painted, frames } = frame()
      expect(frames).toBe(1)
      expect(top()).toBeGreaterThan(0)
      expect(painted).toBe(`offset ${top()}`)
      expect(renderer.getScrollOffset(id)![1]).toBeGreaterThan(0)
    } finally {
      unmount()
    }
  })

  it("do the same for an instant scrollTo", () => {
    const { renderer, frame, id, top, unmount } = setup()
    try {
      renderer.scrollTo(id, 0, 300)
      const { painted, frames } = frame()
      expect(frames).toBe(1)
      expect(top()).toBe(300)
      expect(painted).toBe("offset 300")
    } finally {
      unmount()
    }
  })

  it("do the same for each frame of a smooth scroll", () => {
    const { renderer, frame, id, top, unmount } = setup({ behavior: "smooth" })
    try {
      renderer.scrollTo(id, 0, 300)
      renderer.drawFrame()
      expect(top(), "the first frame starts the animation").toBe(0)
      const seen: number[] = []
      for (let step = 0; step < 4; step++) {
        renderer.clockFastForward(100)
        const { painted, frames } = frame()
        expect(frames).toBe(1)
        expect(painted).toBe(`offset ${top()}`)
        seen.push(top())
      }
      expect(seen[0]).toBeGreaterThan(0)
      expect(seen.at(-1)).toBe(300)
    } finally {
      unmount()
    }
  })

  it("run once per frame when a smooth scroll and a requestAnimationFrame loop share it", async () => {
    const events: number[] = []
    const { renderer, id, top, unmount } = setup(
      { behavior: "smooth", onScroll: (event) => events.push(Math.round(event.scrollTop)) },
      "running",
    )
    let ticks = 0
    let handle = 0
    const loop = () => {
      ticks++
      handle = requestAnimationFrame(loop)
    }
    try {
      handle = requestAnimationFrame(loop)
      renderer.scrollTo(id, 0, 300)
      const perFrame: number[] = []
      for (let frame = 0; frame < 200 && top() < 300; frame++) {
        await new Promise((resolve) => setTimeout(resolve, 8))
        const before = events.length
        renderer.drawFrame()
        perFrame.push(events.length - before)
      }
      expect(top()).toBe(300)
      expect(Math.max(...perFrame), "scroll events in one frame").toBe(1)
      expect(events.length, "a scroll event for each frame that moved the offset").toBeGreaterThan(1)
      expect(ticks, "the loop ran in every frame").toBeGreaterThanOrEqual(perFrame.length)
      expect(events.at(-1)).toBe(300)
    } finally {
      cancelAnimationFrame(handle)
      unmount()
    }
  })

  it("leave the draw of an update that is not a frame to the next frame", () => {
    const events: number[] = []
    const root = createTestRoot()
    const renderer = root.renderer
    try {
      renderer.clockPause()
      root.render(<Page onScroll={(event) => events.push(Math.round(event.scrollTop))} />)
      renderer.flush()
      const id = renderer.findByTestId("scroller")!.id
      renderer.scrollTo(id, 0, 300)
      expect(events, "the draw the write made inline is not a frame").toEqual([])
      renderer.drawFrame()
      expect(events).toEqual([300])
    } finally {
      root.unmount()
    }
  })

  it("report each write once, in the frame that paints it", () => {
    const events: number[] = []
    const { renderer, frame, id, unmount } = setup({ onScroll: (event) => events.push(Math.round(event.scrollTop)) })
    try {
      renderer.scrollTo(id, 0, 300)
      frame()
      expect(events).toEqual([300])
      renderer.scrollTo(id, 0, 0)
      frame()
      expect(events).toEqual([300, 0])
    } finally {
      unmount()
    }
  })

  it("flush what a synchronously dispatched handler changed, through the handler a live window installs", () => {
    function Clicks() {
      const [count, setCount] = useState(0)
      return (
        <div testId="button" style={{ width: 80, height: 20 }} onClick={() => setCount(count + 1)}>
          {`clicks ${count}`}
        </div>
      )
    }
    const root = createTestRoot()
    const renderer = root.renderer
    try {
      renderer.clockPause()
      renderer.setInlineDraws(false)
      root.render(<Clicks />)
      renderer.drawFrame()
      const id = renderer.findByTestId("button")!.id
      // No flush and no await: the dispatch is all that runs between the event and the frame.
      const sync = renderer as unknown as { dispatchSyncEvent(event: EventPayload): unknown }
      sync.dispatchSyncEvent({ elementId: id, eventType: "click", path: [id], target: id })
      renderer.drawFrame()
      expect(renderer.getPaintedText()).toContain("clicks 1")
    } finally {
      root.unmount()
    }
  })
})
