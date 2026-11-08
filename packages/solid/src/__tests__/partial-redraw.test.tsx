/**
 * A window that draws only the part of the picture a frame changed (docs/fork/paint-and-transforms.md, "Partial redraw") shows the picture of
 * the frame drawn whole. The picture the frames drawn in part add up to (`capturePartialPicture`, the persistent target of the Metal
 * renderer) is compared, step by step, with what `captureShownFrame` draws of the scene the window holds: hover patches in a list that has
 * rows with a shadow, a wheel that translates the rows, a pointer that leaves.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot } from "../testing.js"
import type { TestRenderer } from "../testing.js"

const TIMEOUT = 120_000
const COUNT = 200
const ROW = 40
const TICK_MS = 1000 / 120
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "partial-redraw-"))

function open() {
  const app = createTestRoot({ width: 420, height: 500 })
  app.render(() => (
    <div style={{ width: 420, height: 500, backgroundColor: "#101820", flexDirection: "column" }}>
      <div style={{ height: 50, backgroundColor: "#203040", boxShadow: "0px 6px 12px rgba(0, 0, 0, 0.6)", padding: 8 }}>
        <text style={{ color: "#ffffff" }}>header</text>
      </div>
      <virtual-list testId="list" itemCount={COUNT} estimatedItemHeight={ROW} style={{ width: 300, height: 400, marginLeft: 20, marginTop: 10 }}>
        <For each={Array.from({ length: 40 }, (_, index) => index)}>
          {(index) => (
            <div
              testId={`row-${index}`}
              style={{ height: ROW, flexShrink: 0, backgroundColor: index % 2 ? "#223344" : "#2a3b4c", hover: { backgroundColor: "#664422" }, padding: 6 }}
            >
              <text style={{ color: "#ffffff" }}>{`row ${index}`}</text>
            </div>
          )}
        </For>
      </virtual-list>
    </div>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  return app
}

function tick(renderer: TestRenderer) {
  renderer.clockAdvance(TICK_MS)
  renderer.dispatchNativeEvents()
  renderer.presentFrame()
  renderer.drawFrame()
  renderer.presentFrame()
}

function read(file: string): string {
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

/** The picture of the scene the window holds, and the picture the frames drawn in part left (null when it keeps none). */
function pictures(renderer: TestRenderer, name: string): { whole: string; kept: string | null } {
  const whole = path.join(shots, `${process.pid}-${name}-whole.png`)
  const kept = path.join(shots, `${process.pid}-${name}-kept.png`)
  renderer.captureShownFrame(whole)
  return { whole: read(whole), kept: renderer.capturePartialPicture(kept) ? read(kept) : null }
}

describe("partial redraw", () => {
  it(
    "keeps the picture of a frame drawn whole through hover patches, wheel translates and a pointer that leaves",
    () => {
      const app = open()
      try {
        const renderer = app.renderer
        renderer.setPartialRedraw(true)
        for (let i = 0; i < 6; i++) tick(renderer)
        renderer.clockAdvance(3000)
        for (let i = 0; i < 10; i++) tick(renderer)

        let compared = 0
        const check = (name: string) => {
          const { whole, kept } = pictures(renderer, name)
          expect(kept, `${name}: the window keeps a picture`).not.toBeNull()
          expect(kept === whole, `${name}: the picture kept is the frame drawn whole`).toBe(true)
          compared++
        }

        check("start")
        // A pointer that crosses the rows: each crossing is a patch of two rows.
        for (let y = 80; y < 440; y += 17) {
          renderer.dispatchMouseMove(60, y)
          tick(renderer)
          check(`hover-${y}`)
        }
        // A wheel moves the rows, with the pointer over them.
        for (let step = 0; step < 24; step++) {
          renderer.dispatchScrollWheel(60, 200, 0, step < 16 ? 13 : -21, undefined, "moved")
          tick(renderer)
          check(`wheel-${step}`)
        }
        // And the pointer on the rows again, then out of the window.
        for (const y of [120, 160, 200]) {
          renderer.dispatchMouseMove(60, y)
          tick(renderer)
          check(`hover-after-${y}`)
        }
        renderer.dispatchMouseMove(-5, -5)
        tick(renderer)
        check("out")
        expect(compared).toBeGreaterThan(40)
        expect(renderer.getPatchCounters().patchedFrames).toBeGreaterThan(0)
      } finally {
        app.unmount()
      }
    },
    TIMEOUT,
  )

  it(
    "keeps no picture while the window does not ask",
    () => {
      const app = open()
      try {
        const renderer = app.renderer
        for (let i = 0; i < 6; i++) tick(renderer)
        const file = path.join(shots, `${process.pid}-off.png`)
        expect(renderer.capturePartialPicture(file)).toBe(false)
      } finally {
        app.unmount()
      }
    },
    TIMEOUT,
  )
})
