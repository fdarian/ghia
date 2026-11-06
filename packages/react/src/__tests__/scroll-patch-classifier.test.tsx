// @ts-nocheck
/**
 * The classifier of the frames drawn after a list scroll (slice 1 of the scroll-only patch frame): each wheel event over a
 * `<virtual-list>` is classified before its frame is drawn, as a pure translate of the rows of the frame shown or by the first
 * reason it is not (`getPatchCounters().scrollPatch`). Nothing is translated yet: the picture, the boxes and what is under a
 * point are what they are with the classifier off. The cases are those the gpui tests of `window/scroll_patch.rs` pin, through
 * the adapter: rows of 40 in a view of 100.
 */

import fs from "fs"
import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"
import { SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its
// rows are built, not replayed, so there is nothing to translate (`NotRelocatable`) and the frame after is a misprediction.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const ROW = 40
const VIEWPORT = 100
const COUNT = 60
const TIMEOUT = 60_000

type Rows = "inert" | "hit"

function Page({ rows }: { rows: Rows }) {
  return (
    <virtual-list
      testId="list"
      itemCount={COUNT}
      estimatedItemHeight={ROW}
      overdraw={0}
      style={{ width: 200, height: VIEWPORT }}
    >
      {Array.from({ length: COUNT }, (_, index) => (
        <div
          key={index}
          testId={`row-${index}`}
          style={{
            height: ROW,
            flexShrink: 0,
            backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
            ...(rows === "inert" ? { pointerEvents: "none" } : { hover: { backgroundColor: "#664422" } }),
          }}
        >
          <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
        </div>
      ))}
    </virtual-list>
  )
}

function open(rows: Rows) {
  const root = createTestRoot({ width: 300, height: 200 })
  root.render(<Page rows={rows} />)
  const renderer = root.renderer
  renderer.setA11yActive(false)
  renderer.dispatchNativeEvents()
  renderer.flush()
  return { ...root, renderer }
}

type Wheel = { x: number; y: number; by: number }

function wheel(renderer, { x, y, by }: Wheel) {
  renderer.nativeSimulateScrollWheel(x, y, 0, by)
  renderer.dispatchNativeEvents()
}

function counts(renderer) {
  const { frames, eligible, mispredicted, hoverOnly, reasons } = renderer.getPatchCounters().scrollPatch
  const named = Object.fromEntries(Object.entries(reasons).filter(([, count]) => count > 0))
  return { frames, eligible, mispredicted, hoverOnly, reasons: named }
}

function since(renderer, before, action: () => void) {
  const was = before ?? counts(renderer)
  action()
  const now = counts(renderer)
  const reasons: Record<string, number> = {}
  for (const [reason, count] of Object.entries(now.reasons)) reasons[reason] = count - (was.reasons[reason] ?? 0)
  return {
    frames: now.frames - was.frames,
    eligible: now.eligible - was.eligible,
    mispredicted: now.mispredicted - was.mispredicted,
    hoverOnly: now.hoverOnly - was.hoverOnly,
    reasons: Object.fromEntries(Object.entries(reasons).filter(([, count]) => count !== 0)),
  }
}

/** A first wheel and its way back: the rows are recorded, and the frame shown is one the next can be a translate of. */
function warm(renderer, x: number, y: number) {
  wheel(renderer, { x, y, by: 4 })
  wheel(renderer, { x, y, by: -4 })
}

describeNative("the frames drawn after a list scroll", { timeout: TIMEOUT }, () => {
  unverified("counts a fraction of a row as a translate when the rows take no pointer", () => {
    const { renderer, unmount } = open("inert")
    try {
      warm(renderer, 100, 50)
      const delta = since(renderer, undefined, () => {
        wheel(renderer, { x: 100, y: 50, by: 5 })
        wheel(renderer, { x: 100, y: 50, by: 5 })
      })
      expect(delta).toEqual({ frames: 2, eligible: 2, mispredicted: 0, hoverOnly: 0, reasons: {} })
    } finally {
      unmount()
    }
  })

  it("counts a scroll that brings a row in as a membership change", () => {
    const { renderer, unmount } = open("inert")
    try {
      warm(renderer, 100, 50)
      // The rows 0 to 2 show (40, 80 and 20 of the third); at 25 the row 3 does.
      const delta = since(renderer, undefined, () => wheel(renderer, { x: 100, y: 50, by: 25 }))
      expect(delta).toEqual({ frames: 1, eligible: 0, mispredicted: 0, hoverOnly: 0, reasons: { Membership: 1 } })
    } finally {
      unmount()
    }
  })

  unverified("counts a pointer that crosses from a row to the next as a hover change", () => {
    const { renderer, unmount } = open("hit")
    try {
      warm(renderer, 100, 38)
      // The pointer at 38 is in the row 0 (0 to 40) and in the row 1 after a scroll by 5.
      const delta = since(renderer, undefined, () => wheel(renderer, { x: 100, y: 38, by: 5 }))
      expect(delta.frames).toBe(1)
      expect(delta.reasons).toEqual({ Hover: 1 })
      expect(delta.hoverOnly, "nothing else stops it").toBe(1)
    } finally {
      unmount()
    }
  })

  it("does not count a pointer that stays in its row", () => {
    const { renderer, unmount } = open("hit")
    try {
      warm(renderer, 100, 10)
      const delta = since(renderer, undefined, () => wheel(renderer, { x: 100, y: 10, by: 5 }))
      expect(delta.reasons.Hover ?? 0).toBe(0)
    } finally {
      unmount()
    }
  })

  it("counts nothing with the classifier off", () => {
    const { renderer, unmount } = open("inert")
    try {
      renderer.setScrollPatchEnabled(false)
      warm(renderer, 100, 50)
      wheel(renderer, { x: 100, y: 50, by: 5 })
      expect(counts(renderer).frames).toBe(0)
    } finally {
      unmount()
    }
  })
})

const shotFile = (name: string) => `${SHOTS_DIR}/scroll-patch-${process.pid}-${name}.png`

function picture(renderer, name: string): Buffer {
  const file = shotFile(name)
  fs.rmSync(file, { force: true })
  renderer.captureScreenshot(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes
}

function boxes(renderer) {
  const out: Record<string, unknown> = {}
  for (const element of renderer.findByType("div")) {
    const box = renderer.getElementBounds(element.id)
    if (box) out[String(element.id)] = box
  }
  return out
}

describeNative("a list scrolled with the classifier on or off", { timeout: TIMEOUT }, () => {
  const steps: Wheel[] = [
    { x: 100, y: 38, by: 5 },
    { x: 100, y: 38, by: 5 },
    { x: 100, y: 38, by: 30 },
    { x: 100, y: 38, by: 7 },
    { x: 100, y: 60, by: -12 },
    { x: 100, y: 60, by: 90 },
    { x: 100, y: 20, by: -200 },
  ]

  for (const rows of ["inert", "hit"] as Rows[]) {
    it(`draws the same picture, boxes and hits (${rows} rows)`, () => {
      const run = (classify: boolean) => {
        const { renderer, unmount } = open(rows)
        try {
          renderer.setScrollPatchEnabled(classify)
          const seen: unknown[] = []
          for (const [index, step] of steps.entries()) {
            wheel(renderer, step)
            seen.push({
              boxes: boxes(renderer),
              under: renderer.getElementsAt(100, 38),
              picture: picture(renderer, `${rows}-${classify}-${index}`).toString("base64"),
            })
          }
          return { seen, frames: counts(renderer).frames }
        } finally {
          unmount()
        }
      }
      const on = run(true)
      const off = run(false)
      expect(on.frames).toBe(steps.length)
      expect(off.frames).toBe(0)
      expect(on.seen).toEqual(off.seen)
    })
  }
})
