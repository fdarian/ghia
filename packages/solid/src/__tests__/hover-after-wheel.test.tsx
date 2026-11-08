/**
 * Hover crossings of a windowed list are patches after the list was scrolled by a wheel (patch-frames.md, "A row the tree destroyed").
 * The rows are a window of the items that moves with `onVisibleRange`, as the mailbox of ghia-bench has it, so a wheel that travels far
 * destroys the rows the pointer was over when the last frame built whole saw it. The pointer chain of that frame still names a row
 * that no longer exists, and an element no build can reach stayed in `Retain::unbuilt`: every tick after it with a hover to paint was
 * declined `Outside` and built whole.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

// Under the retention verifier a frame that replays rows is built a second time and shown as that build, so there is nothing to translate
// or to tell a patch from: the counters are skipped there and the pictures still have to agree.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined && process.env.GPUIX_SCROLL_PATCH_OFF === undefined
const counted = patching && !verifying

const TIMEOUT = 120_000
const COUNT = 600
const ROW = 72
const VIEW = 716
const WINDOW = 60
const FADE_TICKS = 170
const WINDOW_STEP = 10
const WINDOW_LEAD = 15
const TICK_MS = 1000 / 120
const X = 100
const FROM = 5
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "hover-after-wheel-"))

function open() {
  const [windowStart, setWindowStart] = createSignal(0)
  const app = createTestRoot({ width: 300, height: 800 })
  app.render(() => (
    <virtual-list
      testId="list"
      itemCount={COUNT}
      estimatedItemHeight={ROW}
      windowStart={windowStart()}
      onVisibleRange={(event) => setWindowStart(Math.max(0, Math.floor(((event.startIndex ?? 0) - WINDOW_LEAD) / WINDOW_STEP) * WINDOW_STEP))}
      style={{ width: 200, height: VIEW }}
    >
      <For each={Array.from({ length: WINDOW }, (_, offset) => windowStart() + offset)}>
        {(index) => (
          <div testId={`row-${index}`} style={{ height: ROW, flexShrink: 0, backgroundColor: "#223344", hover: { backgroundColor: "#664422" } }}>
            <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
          </div>
        )}
      </For>
    </virtual-list>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  return app
}

function tick(renderer: TestRenderer) {
  renderer.clockAdvance(TICK_MS)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

function picture(renderer: TestRenderer, name: string): string {
  const file = path.join(shots, `${process.pid}-${name}.png`)
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

const unpatchable = (reasons: string) => Object.values(JSON.parse(reasons) as Record<string, number>).reduce((total, count) => total + count, 0)

function run(patchEnabled: boolean) {
  const app = open()
  try {
    const renderer = app.renderer
    renderer.setPatchEnabled(patchEnabled)
    for (let i = 0; i < 5; i++) tick(renderer)
    renderer.clockAdvance(3000)
    for (let i = 0; i < 20; i++) tick(renderer)
    // The pointer is over the list while a wheel takes the window far from where it was and back.
    renderer.dispatchMouseMove(X, 358)
    tick(renderer)
    for (const dy of [30, -30]) {
      for (let i = 0; i < 360; i++) {
        renderer.dispatchScrollWheel(X, 358, 0, dy, undefined, "moved")
        tick(renderer)
      }
    }
    // The list is at the top again, with its scrollbar showing, as in the bench, and the bar holds for a second and fades for 200 ms:
    // a step of the fade is the thumb written over the frame shown and not a frame, so the rows keep what the wheel left them.
    const fadeBefore = renderer.getPatchCounters()
    const paintedBefore = renderer.getPaintedFrameCount()
    const fade: string[] = []
    for (let i = 0; i < FADE_TICKS; i++) {
      // The end of the hold is a timer of the executor, which the window's clock does not move.
      renderer.advanceTime(TICK_MS)
      tick(renderer)
      if (i % 6 === 0) fade.push(picture(renderer, `${patchEnabled}-fade-${i}`))
    }
    const fadeAfter = renderer.getPatchCounters()
    const faded = {
      pictures: fade,
      whole: renderer.getPaintedFrameCount() - paintedBefore,
      thumbRepaints: fadeAfter.thumbRepaints - fadeBefore.thumbRepaints,
      unpatchable: unpatchable(fadeAfter.unpatchable) - unpatchable(fadeBefore.unpatchable),
    }
    const list = renderer.findByTestId("list")!.id
    expect(renderer.getScrollMetrics(list)![1]).toBe(0)

    // A sweep down the list crosses a row every `ROW` pixels. The first sweep builds the rows the wheel put elsewhere than they were
    // recorded (a patch of one is `Hover:Relocated` until a frame builds it where it stands); the second finds every row ready.
    const sweep = (name: string) => {
      const before = renderer.getPatchCounters()
      let crossings = 0
      let previous = FROM
      for (let y = FROM; y < VIEW; y += ROW / 4) {
        renderer.dispatchMouseMove(X, y, undefined, { x: 0, y: y - previous })
        if (Math.floor(y / ROW) !== Math.floor(previous / ROW)) crossings++
        previous = y
        tick(renderer)
        tick(renderer)
      }
      const after = renderer.getPatchCounters()
      return {
        crossings,
        patched: after.patchedFrames - before.patchedFrames,
        outside: (JSON.parse(after.unpatchable).Outside ?? 0) - (JSON.parse(before.unpatchable).Outside ?? 0),
        unpatchable: unpatchable(after.unpatchable) - unpatchable(before.unpatchable),
        picture: picture(renderer, `${patchEnabled}-${name}`),
      }
    }
    const first = sweep("first")
    renderer.dispatchMouseMove(X, FROM)
    tick(renderer)
    tick(renderer)
    const second = sweep("second")
    return { faded, first, second, mismatches: renderer.getRetainedCounters().mismatches }
  } finally {
    app.unmount()
  }
}

describe.skipIf(!hasNativeTestRenderer)("Solid: hover crossings of a windowed list after a wheel", () => {
  it(
    "are patches, and show what frames built whole show",
    () => {
      const on = run(true)
      const off = run(false)
      expect(on.mismatches).toBe(0)
      expect(on.faded.pictures).toEqual(off.faded.pictures)
      expect(on.first.picture).toEqual(off.first.picture)
      expect(on.second.picture).toEqual(off.second.picture)
      if (!counted) return
      expect(on.faded.thumbRepaints, "the fade is steps of the thumb").toBeGreaterThan(0)
      expect(on.faded.whole, "the hold and the fade of the bar after the wheel build no frame").toBe(0)
      expect(on.faded.unpatchable, "a step of the fade is not a decline").toBe(0)
      expect(on.first.unpatchable, "no row was replayed from a recording made elsewhere, so no crossing is a frame built whole").toBe(0)
      expect(on.first.outside + on.second.outside, "no tick is declined for an element outside every unit").toBe(0)
      expect(on.second.crossings).toBeGreaterThanOrEqual(4)
      expect(on.second.unpatchable, "every row was built where it stands by the first sweep").toBe(0)
      expect(on.second.patched, "each crossing is a patch").toBeGreaterThanOrEqual(on.second.crossings)
    },
    TIMEOUT,
  )
})
