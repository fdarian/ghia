// @ts-nocheck
/**
 * A box with `dragOffset` (a `Reorder.Item`) beside a looping opacity animation. While nobody holds the box
 * the ticks of the loop are patched as they are on a page without it; while one holds it the ticks are whole
 * frames (the drag's values reach a box that is not bound to them, and nothing else tells a tick that the
 * pointer moved it), and the page patches again once the box has glided back to its slot. The picture is
 * the one a build of the same state draws at the press, between moves, at the release, half way through the
 * glide back and after it. Run with GPUIX_RETAIN_VERIFY=1 too.
 */

import React, { useState } from "react"
import { expect, it } from "vitest"
import { Reorder, motion } from "../index"
import { describeNative, setup } from "./retained-harness.js"

const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined
const linear = { duration: 1, ease: "linear" } as const

function Page() {
  const [order, setOrder] = useState(["a", "b", "c"])
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
      <motion.div
        animate={{ opacity: [1, 0.4, 1] }}
        transition={{ duration: 1, repeat: Number.POSITIVE_INFINITY }}
        style={{ width: 40, height: 40, backgroundColor: "#6B97FF" }}
      />
      <Reorder.Group axis="y" values={order} onReorder={setOrder} style={{ display: "flex", flexDirection: "column" }}>
        {order.map((name) => (
          <Reorder.Item
            key={name}
            value={name}
            testId={name}
            transition={linear}
            style={{ width: 120, height: 24, backgroundColor: name === "a" ? "#cc3333" : "#999999" }}
          />
        ))}
      </Reorder.Group>
      {Array.from({ length: 200 }, (_, index) => (
        <div key={index} style={{ width: 80, height: 4, backgroundColor: "#cccccc" }} />
      ))}
    </div>
  )
}

function counters(renderer) {
  return {
    patched: renderer.getPatchCounters().patchedFrames,
    whole: renderer.getPaintedFrameCount(),
  }
}

/** Draws `count` ticks of 16 ms as the display link does, and returns what they were. */
function ticks(renderer, count: number, each?: (index: number) => void) {
  const before = counters(renderer)
  for (let index = 0; index < count; index++) {
    renderer.clockAdvance(16)
    renderer.dispatchNativeEvents()
    renderer.drawFrame()
    each?.(index)
  }
  const after = counters(renderer)
  return { patched: after.patched - before.patched, whole: after.whole - before.whole }
}

describeNative("a box with dragOffset beside a loop", { timeout: 120_000 }, () => {
  it("patches while nobody holds the box, draws whole while one does, and shows what a build shows", () => {
    const view = setup(<Page />)
    const renderer = view.renderer
    try {
      view.settle()
      ticks(renderer, 60)
      const idle = ticks(renderer, 150)
      if (patching) expect(idle, "idle").toEqual({ patched: 150, whole: 0 })

      const top = view.bounds("a").y
      const [x, y] = view.center("a")
      renderer.nativeSimulateMouseDown(x, y)
      renderer.drawFrame()
      view.expectWhatABuildShows("press", ["a", "b", "c"])
      expect(view.bounds("a").y).toBe(top)

      renderer.nativeSimulateMouseMove(x, y + 8)
      renderer.drawFrame()
      expect(view.bounds("a").y, "the box follows the pointer").toBe(top + 8)
      view.expectWhatABuildShows("moved", ["a", "b", "c"])

      const held = ticks(renderer, 60, (index) => {
        if (index % 15 === 0) {
          expect(view.bounds("a").y, "a tick leaves the held box where the pointer put it").toBe(top + 8)
          view.expectWhatABuildShows(`held-${index}`, ["a", "b", "c"])
        }
      })
      if (patching) expect(held.patched, "no tick is patched while the box is held").toBe(0)

      renderer.nativeSimulateMouseMove(x, y + 12)
      renderer.drawFrame()
      expect(view.bounds("a").y).toBe(top + 12)
      ticks(renderer, 3)
      expect(view.bounds("a").y).toBe(top + 12)

      renderer.nativeSimulateMouseUp(x, y + 12, 0)
      renderer.drawFrame()
      view.expectWhatABuildShows("released", ["a", "b", "c"])
      expect(view.bounds("a").y, "released where it was held").toBeCloseTo(top + 12, 0)

      const gliding = ticks(renderer, 30)
      const half = view.bounds("a").y - top
      expect(half, "gliding back").toBeGreaterThan(1)
      expect(half).toBeLessThan(11)
      if (patching) expect(gliding.patched, "no tick is patched while the glide runs").toBe(0)
      view.expectWhatABuildShows("gliding", ["a", "b", "c"])

      ticks(renderer, 45)
      expect(view.bounds("a").y, "back in its slot").toBeCloseTo(top, 0)
      view.expectWhatABuildShows("back", ["a", "b", "c"])
      const rest = ticks(renderer, 150)
      if (patching) {
        expect(rest.patched, "patched again after the drag").toBeGreaterThanOrEqual(147)
        expect(rest.whole).toBeLessThanOrEqual(3)
      }
      view.finish(false)
    } finally {
      view.unmount()
    }
  })
})
