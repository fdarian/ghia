// @ts-nocheck
/**
 * The registries a frame resets (the text, the start regions, the painted text and the paragraphs) hold what the last frame built
 * whole wrote, and a patch takes the writes of the roots it paints again out and puts its own in their place. A hover that is
 * patched over and over with no frame built whole between the patches must leave them the size they were, and what they answer
 * (the start region a press lands in, the text under a point) the same. Rows of 40 in a view of 100: the even rows opt out of
 * selection with `userSelect: "none"`, so a start region decides which press starts a selection.
 */

import React from "react"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined

const ROW = 40
const COUNT = 12
const TIMEOUT = 60_000

type Kind = "list" | "column"

function Row({ index }: { index: number }) {
  return (
    <div
      style={{
        width: 150,
        height: ROW,
        flexShrink: 0,
        backgroundColor: index % 2 === 0 ? "#223344" : "#334455",
        hover: { backgroundColor: "#664422" },
      }}
    >
      <div style={{ color: "#ffffff", userSelect: index % 2 === 0 ? "none" : "text" }}>{`row-${index}`}</div>
    </div>
  )
}

function Page({ kind }: { kind: Kind }) {
  const rows = Array.from({ length: COUNT }, (_, index) => <Row key={index} index={index} />)
  if (kind === "column") {
    return <div style={{ width: 200, height: 100, flexDirection: "column", overflow: "hidden" }}>{rows}</div>
  }
  return (
    <virtual-list itemCount={COUNT} estimatedItemHeight={ROW} overdraw={0} style={{ width: 200, height: 100, scrollbarWidth: "none" }}>
      {rows}
    </virtual-list>
  )
}

function move(renderer, y: number) {
  renderer.nativeSimulateMouseMove(20, y)
  renderer.dispatchNativeEvents()
  renderer.drawFrame()
}

/** The pointer going down the three rows that show and back up, once. */
function cross(renderer) {
  for (const y of [20, 55, 95, 55, 20]) move(renderer, y)
}

/** What a press on each of the rows that show selects: the text of a row that can be selected, nothing for the others. */
function pressed(renderer) {
  return [8, 48].map((y) => {
    const selected = renderer.dragSelect(2, y, 60, y)
    renderer.clearSelection()
    return selected
  })
}

function open(kind: Kind) {
  const root = createTestRoot({ width: 300, height: 200 })
  root.render(<Page kind={kind} />)
  root.renderer.dispatchNativeEvents()
  root.renderer.flush()
  root.renderer.setA11yActive(false)
  return root
}

describeNative("registries over many hover patches", { timeout: TIMEOUT }, () => {
  for (const kind of ["list", "column"] as const) {
    it(`keep their size and their answers, in a ${kind}`, () => {
      const answers = (() => {
        const fresh = open(kind)
        try {
          return pressed(fresh.renderer)
        } finally {
          fresh.unmount()
        }
      })()
      expect(answers[0]).toBeNull()
      expect(answers[1]).toContain("row-1")
      const { renderer, unmount } = open(kind)
      try {
        // The first crossings record the rows with a hover style, then the frame the next one is patched from is built whole.
        for (let i = 0; i < 3; i++) cross(renderer)
        const before = renderer.getRegistrySlots()
        const patches = renderer.getPatchCounters().patchedFrames
        for (let i = 0; i < 40; i++) cross(renderer)
        if (!verifying) expect(renderer.getPatchCounters().patchedFrames - patches).toBeGreaterThan(100)
        expect(renderer.getRegistrySlots()).toEqual(before)
        expect(pressed(renderer)).toEqual(answers)
      } finally {
        unmount()
      }
    })
  }
})
