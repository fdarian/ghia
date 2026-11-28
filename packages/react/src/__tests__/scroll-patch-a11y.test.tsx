// @ts-nocheck
/**
 * With a screen reader connected (the test window pretends one is, until `setA11yActive(false)`), a wheel over a list is still a
 * translate frame: the rows that stay have the bounds the translate gives them in the accessibility tree, the rows that leave are
 * out of it and the rows that come in are in it, as the frame built whole has it (`getShownA11yTree` does not flush, so it is the tree
 * the translate left and not one drawn over it). `A11y` is no reason a frame is held but for a screen reader that came or went since
 * the frame shown.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
// Under the retention verifier a frame that replays rows is built a second time, whole, and that build is the frame shown: its rows
// are built, not replayed, so the next scroll has nothing to translate. The verified case below makes its own frames.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const unverified = it.skipIf(verifying)

const COUNT = 80
const VIEW = 600
const GUTTER = 192
const TIMEOUT = 120_000

const height = (index: number) => 30 + ((index * 7) % 5) * 6
const top = (index: number) => Array.from({ length: index }, (_, row) => height(row)).reduce((sum, h) => sum + h, 0)
const LAST_TOP = top(COUNT) - VIEW

function rowsAt(scrolled: number): number[] {
  return Array.from({ length: COUNT }, (_, row) => row).filter((row) => top(row) < scrolled + VIEW && top(row) + height(row) > scrolled)
}

function downBy(scrolled: number, count: number): number {
  return top(rowsAt(scrolled).at(-1)! + count) - VIEW + 1
}

function upBy(scrolled: number, count: number): number {
  return top(rowsAt(scrolled)[0] - count + 1) - 1
}

function Rows(props: { log: number[] }) {
  return (
    <div style={{ width: 300, height: 700, backgroundColor: "#ffffff" }}>
      <div style={{ height: 10, backgroundColor: "#eeeeee" }} />
      <virtual-list
        testId="list"
        role="list"
        aria-label="Rows"
        itemCount={COUNT}
        estimatedItemHeight={40}
        overdraw={0}
        style={{ width: 200, height: VIEW, scrollbarWidth: "none" }}
      >
        {Array.from({ length: COUNT }, (_, index) => (
          <div
            key={index}
            testId={`row-${index}`}
            role="listitem"
            aria-label={`row-${index}`}
            onClick={() => props.log.push(index)}
            style={{
              width: 180,
              height: height(index),
              flexShrink: 0,
              backgroundColor: `hsl(${(index * 37) % 360}, 40%, ${index % 2 === 0 ? 40 : 55}%)`,
            }}
          >
            <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
          </div>
        ))}
      </virtual-list>
    </div>
  )
}

function open() {
  const log: number[] = []
  const root = createTestRoot({ width: 300, height: 700 })
  root.render(<Rows log={log} />)
  const renderer = root.renderer
  renderer.dispatchNativeEvents()
  renderer.flush()
  const list = renderer.findByTestId("list")!.id
  // Every row measured, by showing every row once with the translate off.
  renderer.setScrollPatchEnabled(false)
  for (let scrolled = 0; scrolled <= LAST_TOP; scrolled += 20) renderer.scrollTo(list, 0, scrolled)
  renderer.scrollTo(list, 0, 0)
  renderer.setScrollPatchEnabled(true)
  return { ...root, renderer, list, log }
}

/** Builds every row that shows again, so that what the frame shown holds of them was recorded where they are now. */
function rebuild(renderer) {
  renderer.nativeSimulateMouseMove(GUTTER, 300)
  renderer.dispatchNativeEvents()
  renderer.setRetainPlanning(false)
  renderer.setRetainPlanning(true)
  renderer.flush()
}

function scroll(renderer) {
  return renderer.getPatchCounters().scrollPatch
}

/** The tree of the frame shown, with what differs from frame to frame (its number and time) left out. */
function tree(renderer) {
  const shown = renderer.getShownA11yTree()
  return { ...shown, frame: shown.frame && { ...shown.frame, rendered_at: undefined, frame_number: undefined } }
}

function labels(shown): string[] {
  return Object.values(shown.nodes ?? {})
    .map((node) => node.aria?.label)
    .filter((label): label is string => typeof label === "string" && label.startsWith("row-"))
}

type Step = { by: "down" | "up"; rows: number }

const steps: Step[] = [
  { by: "down", rows: 1 },
  { by: "down", rows: 2 },
  { by: "down", rows: 5 },
  { by: "up", rows: 1 },
  { by: "up", rows: 2 },
  { by: "up", rows: 5 },
  { by: "down", rows: 5 },
  { by: "up", rows: 1 },
]

function run(translate: boolean) {
  const opened = open()
  const renderer = opened.renderer
  const list = opened.list
  const unmount = opened.unmount
  try {
    renderer.setScrollPatchEnabled(translate)
    let scrolled = 300
    renderer.scrollTo(list, 0, scrolled)
    rebuild(renderer)
    const trees: unknown[] = []
    const translated: boolean[] = []
    for (const step of steps) {
      const before = scroll(renderer)
      const next = step.by === "down" ? downBy(scrolled, step.rows) : upBy(scrolled, step.rows)
      renderer.nativeSimulateScrollWheel(GUTTER, 300, 0, next - scrolled)
      renderer.dispatchNativeEvents()
      scrolled = next
      translated.push(scroll(renderer).patched > before.patched)
      trees.push(tree(renderer))
    }
    return { trees, translated, scrolled, counters: scroll(renderer), mismatches: renderer.getRetentionMismatches() }
  } finally {
    unmount()
  }
}

describeNative("a wheel over a list with the accessibility tree built", { timeout: TIMEOUT }, () => {
  unverified("is a translate frame, and the tree is the one the frame built whole has", () => {
    const on = run(true)
    const off = run(false)
    expect(off.counters.frames).toBe(0)
    expect(on.translated, "every step is a translate").toEqual(steps.map(() => true))
    expect(on.counters.held.A11y ?? 0).toBe(0)
    expect(on.counters.reasons.A11y ?? 0).toBe(0)
    expect(on.counters.applyDeclines.A11y ?? 0).toBe(0)
    expect(on.counters.mispredicted).toBe(0)
    expect(on.counters.membershipFrames).toBeGreaterThan(0)
    expect(on.mismatches).toEqual([])
    expect(on.trees).toEqual(off.trees)
    // The rows the last step shows are in the tree, and the ones above them are not.
    const shown = rowsAt(on.scrolled)
    expect(shown.length).toBeGreaterThan(0)
    const named = labels(on.trees.at(-1))
    for (const row of shown) expect(named, `row ${row} shows`).toContain(`row-${row}`)
    for (let row = 0; row < shown[0]; row += 1) expect(named, `row ${row} left`).not.toContain(`row-${row}`)
  })

  unverified("puts the rows that came in in the tree and takes the ones that left out of it", () => {
    const opened = open()
  const renderer = opened.renderer
  const list = opened.list
  const unmount = opened.unmount
    try {
      renderer.scrollTo(list, 0, 300)
      rebuild(renderer)
      const first = rowsAt(300)[0]
      expect(labels(tree(renderer))).toContain(`row-${first}`)
      const patched = scroll(renderer).patched
      const to = downBy(300, 5)
      renderer.nativeSimulateScrollWheel(GUTTER, 300, 0, to - 300)
      renderer.dispatchNativeEvents()
      expect(scroll(renderer).patched).toBe(patched + 1)
      const named = labels(tree(renderer))
      expect(named).not.toContain(`row-${first}`)
      for (const row of rowsAt(to)) expect(named).toContain(`row-${row}`)
    } finally {
      unmount()
    }
  })

  unverified("is a translate after a screen reader came or went, and edits the tree while one is connected", () => {
    const opened = open()
  const renderer = opened.renderer
  const list = opened.list
  const unmount = opened.unmount
    try {
      renderer.setA11yActive(false)
      let scrolled = 300
      renderer.scrollTo(list, 0, scrolled)
      rebuild(renderer)
      const wheel = (to: number) => {
        const before = scroll(renderer).patched
        renderer.nativeSimulateScrollWheel(GUTTER, 300, 0, to - scrolled)
        renderer.dispatchNativeEvents()
        scrolled = to
        return scroll(renderer).patched - before
      }
      // A screen reader connects: the window is refreshed and the frame after is built whole, with the tree.
      renderer.setA11yActive(true)
      rebuild(renderer)
      expect(labels(tree(renderer)).length).toBeGreaterThan(0)
      expect(wheel(downBy(scrolled, 2)), "a translate with the tree built").toBe(1)
      expect(labels(tree(renderer))).toContain(`row-${rowsAt(scrolled).at(-1)}`)
      renderer.setA11yActive(false)
      rebuild(renderer)
      expect(wheel(downBy(scrolled, 2)), "a translate with none").toBe(1)
      expect(scroll(renderer).applyDeclines.A11y ?? 0).toBe(0)
    } finally {
      unmount()
    }
  })

  // Every row of the page is built in the frame that is not the scroll (`rebuild`), so that nothing is replayed, no frame is built
  // a second time under the verifier, and the rows of the frame shown can be moved. The tree the translate left is compared with the
  // frame built whole after it.
  it("is the frame built whole under the retention verifier", () => {
    const opened = open()
  const renderer = opened.renderer
  const list = opened.list
  const unmount = opened.unmount
    try {
      renderer.setRetainVerify(true)
      let scrolled = 300
      renderer.scrollTo(list, 0, scrolled)
      const before = scroll(renderer)
      const compared = renderer.getRetainedCounters().verified
      for (const [index, step] of steps.entries()) {
        rebuild(renderer)
        const next = step.by === "down" ? downBy(scrolled, step.rows) : upBy(scrolled, step.rows)
        renderer.nativeSimulateScrollWheel(GUTTER, 300, 0, next - scrolled)
        renderer.dispatchNativeEvents()
        scrolled = next
        expect(renderer.getRetentionMismatches().join("\n"), `step ${index}`).toBe("")
      }
      const after = scroll(renderer)
      expect(after.membershipFrames - before.membershipFrames, "the scrolls are translates that were compared with a build").toBe(steps.length)
      expect(after.mispredicted).toBe(0)
      expect(after.reasons.A11y ?? 0).toBe(0)
      expect(renderer.getRetainedCounters().mismatches).toBe(0)
      expect(renderer.getRetainedCounters().verified).toBeGreaterThan(compared)
    } finally {
      unmount()
    }
  })
})
