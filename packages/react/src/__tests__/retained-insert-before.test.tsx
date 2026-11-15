/// The rows of a TanStack Virtual list that something is inserted before, as one that is scrolled up does, or that
/// something is removed in front of: `position: absolute` rows moved by a `transform` that follows from the slot a row
/// is for, in a container as high as every slot. A row that keeps its slot is where it was, so the frame replays it
/// whatever place it now has among its siblings (the place is not part of what it was built from), and the text of the
/// page is in document order, for a selection and for what a copy reads. The rows are painted in document order, and
/// in the reverse of it (a `z-index` that falls with the document), where a text that kept the place its row had when
/// it was recorded would be ordered by it.

import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const SLOTS = 30
const ROW = 40
const LINE = ROW / 2
const VIEW = { width: 300, height: 300 }

function Rows(props: { slots: number[]; reversedPaint: boolean }) {
  return (
    <div testId="scroller" style={{ ...VIEW, overflow: "auto" }}>
      <div style={{ position: "relative", width: "100%", height: SLOTS * ROW }}>
        {props.slots.map((slot) => (
          <div
            key={slot}
            testId={`row-${slot}`}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: ROW,
              transform: `translateY(${slot * ROW}px)`,
              ...(props.reversedPaint ? { zIndex: SLOTS - slot } : {}),
            }}
          >
            <div style={{ height: LINE, fontSize: 14, lineHeight: `${LINE}px`, color: "#ffffff" }}>{`Row ${slot}`}</div>
            <div style={{ height: LINE, fontSize: 14, lineHeight: `${LINE}px`, color: "#aaaaaa" }}>{`detail ${slot}`}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The rows of `slots` from the first to the one at `last`, as a drag from the first line of the first to the end of
 *  the first line of the last selects them. */
function textUpTo(slots: number[], last: number) {
  return slots
    .slice(0, last)
    .flatMap((slot) => [`Row ${slot}`, `detail ${slot}`])
    .concat(`Row ${slots[last]}`)
    .join("\n")
}

const LAST = 5

function setup(slots: number[], reversedPaint: boolean, verify: boolean) {
  const root = createTestRoot(VIEW)
  const renderer = root.renderer
  renderer.setRetainPlanning(true)
  renderer.setRetainVerify(verify)
  let shown = slots
  /** Renders `next`, and says how many subtrees the frame that draws it left unbuilt. */
  const show = (next: number[]) => {
    renderer.clearSelection()
    const before = renderer.getRetainedCounters()
    root.render(<Rows slots={next} reversedPaint={reversedPaint} />)
    const skipped = renderer.getRetainedCounters().hits - before.hits
    for (let frame = 0; frame < 4; frame++) renderer.flush()
    const kept = next.filter((slot) => shown.includes(slot)).length
    shown = next
    return { skipped, kept }
  }
  const select = (shown: number[]) => {
    renderer.clearSelection()
    const dragged = renderer.dragSelect(5, shown[0] * ROW + LINE / 2, VIEW.width - 5, shown[LAST] * ROW + LINE / 2)
    return { dragged, copied: renderer.getSelectedText(), expected: textUpTo(shown, LAST) }
  }
  root.render(<Rows slots={slots} reversedPaint={reversedPaint} />)
  for (let frame = 0; frame < 4; frame++) renderer.flush()
  return { ...root, show, select, counters: () => renderer.getRetainedCounters() }
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)

describeNative("rows that something is inserted before or removed in front of", () => {
  it.each([
    { reversedPaint: false, verify: true },
    { reversedPaint: true, verify: true },
    { reversedPaint: false, verify: false },
    { reversedPaint: true, verify: false },
  ])("are replayed and keep the document order of their text, reversed paint $reversedPaint, verifier $verify", ({ reversedPaint, verify }) => {
    const { renderer, show, select, counters, unmount } = setup(range(2, 14), reversedPaint, verify)
    try {
      const first = range(2, 14)
      const initial = select(first)
      expect(initial.dragged).toBe(initial.expected)

      // What a list scrolled up does: rows come in at the front, then go out of it, then one comes in the middle of
      // what is left.
      const steps = [range(0, 14), range(1, 14), range(2, 14).filter((slot) => slot !== 6), range(2, 14), [0, ...range(2, 14)]]
      for (const shown of steps) {
        const label = shown.join(",")
        const frame = show(shown)
        expect(frame.skipped, `each row that is still there is left unbuilt, wherever it is among the others now: ${label}`).toBeGreaterThanOrEqual(frame.kept)
        const selected = select(shown)
        expect(selected.dragged, label).toBe(selected.expected)
        expect(selected.copied, label).toBe(selected.expected)
      }

      const end = counters()
      expect(end.mismatches, renderer.getRetentionMismatches().join("\n")).toBe(0)
      if (verify) expect(end.verified).toBeGreaterThan(0)
    } finally {
      unmount()
    }
  }, 60_000)
})
