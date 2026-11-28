/// Absolute rows placed with `top`, each holding a paragraph with an atomic inline (`display: inline-block`) in the
/// middle of it, with something inserted before them. The rows are retained roots, so the frames after the insertion
/// replay them where they were recorded (the verifier compares each with a build): this holds that the text in the boxes
/// is copied in document order, and that nothing about it is recorded wrongly. How a position inside a box of a paragraph
/// of a root is rebased is held by the unit tests in `text/selection.rs`.

import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const SLOTS = 30
const ROW = 40
const LINE = ROW / 2
const VIEW = { width: 400, height: 400 }

function Rows(props: { slots: number[] }) {
  return (
    <div testId="page" style={VIEW}>
      <div style={{ position: "relative", width: "100%", height: SLOTS * ROW }}>
        {props.slots.map((slot) => (
          <div key={slot} style={{ position: "absolute", top: slot * ROW, left: 0, width: "100%", height: ROW }}>
            <div style={{ height: LINE, fontSize: 14, lineHeight: `${LINE}px`, color: "#ffffff" }}>
              {`Row ${slot} `}
              <span style={{ display: "inline-block", color: "#aaaaaa" }}>{`box ${slot}`}</span>
              {` end ${slot}`}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const line = (slot: number) => `Row ${slot} box ${slot} end ${slot}`

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)

function setup(slots: number[]) {
  const root = createTestRoot(VIEW)
  const renderer = root.renderer
  renderer.setRetainPlanning(true)
  renderer.setRetainVerify(true)
  root.render(<Rows slots={slots} />)
  for (let frame = 0; frame < 4; frame++) renderer.flush()
  const settle = () => {
    for (let frame = 0; frame < 4; frame++) renderer.flush()
  }
  /** Presses on the first line of `from`, has the page show `next`, and drags to the end of the line of `to`. */
  const dragAcross = (from: number, next: number[], to: number) => {
    renderer.clearSelection()
    renderer.native.simulateMouseDown(5, from * ROW + LINE / 2, 0)
    renderer.flush()
    root.render(<Rows slots={next} />)
    settle()
    renderer.native.simulateMouseMove(VIEW.width - 5, to * ROW + LINE / 2)
    renderer.flush()
    renderer.native.simulateMouseUp(VIEW.width - 5, to * ROW + LINE / 2, 0)
    renderer.flush()
    return { copied: renderer.getSelectedText() }
  }
  return { ...root, dragAcross, counters: () => renderer.getRetainedCounters() }
}

describeNative("rows that hold an atomic inline, with something inserted before them", () => {
  it("keep the document order of the text in the box, as a build writes it", () => {
    const { renderer, dragAcross, counters, unmount } = setup(range(2, 14))
    try {
      const steps = [
        { from: 2, shown: range(1, 14), to: 7 },
        { from: 3, shown: range(0, 14), to: 9 },
        { from: 3, shown: [0, ...range(2, 14)], to: 8 },
      ]
      for (const step of steps) {
        const label = `${step.from} to ${step.to} with ${step.shown.join(",")}`
        const dragged = dragAcross(step.from, step.shown, step.to)
        expect(dragged.copied, label).toBe(range(step.from, step.to + 1).map(line).join("\n"))
      }
      const end = counters()
      expect(end.mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
    } finally {
      unmount()
    }
  }, 60_000)
})
