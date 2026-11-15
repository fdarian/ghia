/// Absolute rows placed with `top` (no transform and no `z-index`, so a row forms no stacking context) that each hold
/// a badge that is `position: relative` with a `z-index`. The badge is handed to the stacking context around the rows,
/// and the recording of its row holds it as a hole, painted by the hook the badge had when the row was recorded. A
/// row that something is inserted before is replayed all the same (its place among its siblings is not part of what it
/// was built from), and the badge, which that frame does not visit, has to write its text under the path it has now:
/// the drag that is held across the insert orders the text of the page by it, and what it copies is in document order.

import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const SLOTS = 30
const ROW = 40
const LINE = ROW / 2
const VIEW = { width: 300, height: 400 }

function Rows(props: { slots: number[] }) {
  return (
    <div testId="page" style={VIEW}>
      <div style={{ position: "relative", width: "100%", height: SLOTS * ROW }}>
        {props.slots.map((slot) => (
          <div key={slot} style={{ position: "absolute", top: slot * ROW, left: 0, width: "100%", height: ROW }}>
            <div style={{ height: LINE, fontSize: 14, lineHeight: `${LINE}px`, color: "#ffffff" }}>{`Row ${slot}`}</div>
            <div
              style={{ position: "relative", zIndex: 1, height: LINE, fontSize: 14, lineHeight: `${LINE}px`, color: "#aaaaaa" }}
            >{`badge ${slot}`}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The text of the rows from `first` to `last` (slots), as a drag from the first line of one to the end of the first line
 *  of the other selects it. */
function textFrom(first: number, last: number) {
  const slots = Array.from({ length: last - first }, (_, index) => first + index)
  return slots
    .flatMap((slot) => [`Row ${slot}`, `badge ${slot}`])
    .concat(`Row ${last}`)
    .join("\n")
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)

function setup(slots: number[], verify: boolean) {
  const root = createTestRoot(VIEW)
  const renderer = root.renderer
  renderer.setRetainPlanning(true)
  renderer.setRetainVerify(verify)
  root.render(<Rows slots={slots} />)
  for (let frame = 0; frame < 4; frame++) renderer.flush()
  const settle = () => {
    for (let frame = 0; frame < 4; frame++) renderer.flush()
  }
  /** Presses on the first line of `from`, has the page show `next`, and drags to the first line of `to`: the drag
   *  orders the text of the frame the page was shown in. */
  const dragAcross = (from: number, next: number[], to: number) => {
    renderer.clearSelection()
    renderer.native.simulateMouseDown(5, from * ROW + LINE / 2, 0)
    renderer.flush()
    const before = renderer.getRetainedCounters()
    root.render(<Rows slots={next} />)
    const skipped = renderer.getRetainedCounters().hits - before.hits
    settle()
    renderer.native.simulateMouseMove(VIEW.width - 5, to * ROW + LINE / 2)
    renderer.flush()
    renderer.native.simulateMouseUp(VIEW.width - 5, to * ROW + LINE / 2, 0)
    renderer.flush()
    return { skipped, copied: renderer.getSelectedText() }
  }
  return { ...root, dragAcross, counters: () => renderer.getRetainedCounters() }
}

describeNative("rows that hold a lifted badge, with something inserted before them while a drag is held", () => {
  it.each([{ verify: true }, { verify: false }])(
    "order the text of the page by the paths the rows have now, verifier $verify",
    ({ verify }) => {
      const { renderer, dragAcross, counters, unmount } = setup(range(2, 14), verify)
      try {
        const steps = [
          { from: 2, shown: range(1, 14), to: 7 },
          { from: 3, shown: range(0, 14), to: 9 },
          { from: 3, shown: [0, ...range(2, 14)], to: 8 },
        ]
        for (const step of steps) {
          const label = `${step.from} to ${step.to} with ${step.shown.join(",")}`
          const dragged = dragAcross(step.from, step.shown, step.to)
          expect(dragged.skipped, `the rows that are still there are left unbuilt: ${label}`).toBeGreaterThan(0)
          expect(dragged.copied, label).toBe(textFrom(step.from, step.to))
        }
        const end = counters()
        expect(end.mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
        if (verify) expect(end.verified).toBeGreaterThan(0)
      } finally {
        unmount()
      }
    },
    60_000,
  )
})
