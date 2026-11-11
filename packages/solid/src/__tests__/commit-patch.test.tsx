/**
 * A commit that only changes how elements paint is drawn as a tick, which a patch frame takes: the roots that hold the restyled
 * elements are built again and gpui writes their primitives over the frame shown (patch-frames.md, "Commit patches"). A commit the
 * patch cannot follow is drawn whole, and what the page shows is what patching off shows. Rows of 40 in a virtual list of 50 that
 * show 10, each with a hover background like the row of ghia-bench's mailbox; the selection moves by a signal.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"
import type { StyleDesc } from "@ghia/native"

// Under the retention verifier a frame that replays roots is built a second time and that build is the frame shown, and a patch is
// compared with the frame built whole after it: the counters that tell a patch from a frame built whole are skipped there.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined
const counted = patching && !verifying

const TIMEOUT = 60_000
const test = (name: string, run: () => void) => it(name, run, TIMEOUT)

const COUNT = 50
const ROW = 40
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "commit-patch-"))

type Variant = "paint" | "opacity" | "appear" | "layout" | "outside"

/**
 * What the rows are: `hover` (a virtual list, each row with a hover background), `list` (a virtual list of rows that declare no hover),
 * `plain` (rows of a plain list that are a div with two empty divs, no hover) and `nested` (the same with the two divs in one more div).
 */
type Shape = "hover" | "list" | "plain" | "nested"

const rowStyle: StyleDesc = {
  width: 150,
  height: ROW,
  flexShrink: 0,
  borderBottom: "1px solid #112233",
  hover: { backgroundColor: "#664422" },
}

/** A row without a hover, which has a background in both states so that the quad of the row is the same. */
function plainStyle(selected: boolean): StyleDesc {
  return { width: 150, height: ROW, flexShrink: 0, borderBottom: "1px solid #112233", backgroundColor: selected ? "#335577" : "#223344" }
}

const cell: StyleDesc = { width: 10, height: 10 }

/** What a row is when it is selected, for each kind of commit. */
function styleOf(variant: Variant, selected: boolean): StyleDesc {
  if (!selected) return variant === "appear" ? { ...rowStyle, hover: undefined } : rowStyle
  switch (variant) {
    case "paint":
      return { ...rowStyle, backgroundColor: "#335577", hover: { backgroundColor: "#335577" } }
    case "opacity":
      return { ...rowStyle, opacity: 0.6 }
    case "appear":
      return { ...rowStyle, hover: undefined, backgroundColor: "#335577" }
    case "layout":
      return { ...rowStyle, height: ROW + 4 }
    case "outside":
      return rowStyle
  }
}

function open(variant: Variant, shape: Shape = "hover") {
  const [selected, setSelected] = createSignal(0)
  const indices = Array.from({ length: COUNT }, (_, index) => index)
  const app = createTestRoot({ width: 300, height: 500 })
  app.render(() => (
    <div style={{ width: 300, height: 500, flexDirection: "column" }}>
      <div testId="header" style={{ color: variant === "outside" ? `#${(0x808080 + selected()).toString(16)}` : "#cccccc" }}>
        header
      </div>
      {shape === "plain" || shape === "nested" ? (
        <div testId="list" style={{ width: 200, flexDirection: "column" }}>
          <For each={indices}>
            {(index) => (
              <div testId={`row-${index}`} style={plainStyle(selected() === index)}>
                {shape === "plain" ? (
                  <>
                    <div style={cell} />
                    <div style={cell} />
                  </>
                ) : (
                  <div>
                    <div style={cell} />
                    <div style={cell} />
                  </div>
                )}
              </div>
            )}
          </For>
        </div>
      ) : (
        <virtual-list testId="list" itemCount={COUNT} estimatedItemHeight={ROW} overdraw={0} style={{ width: 200, height: 400, scrollbarWidth: "none" }}>
          <For each={indices}>
            {(index) => (
              <div testId={`row-${index}`} style={shape === "list" ? plainStyle(selected() === index) : styleOf(variant, selected() === index)}>
                <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
              </div>
            )}
          </For>
        </virtual-list>
      )}
      <div testId="detail" style={{ position: "absolute", left: 210, top: 0, width: 80, height: 100, overflow: "scroll" }}>
        <div style={{ width: 60, height: 300, backgroundColor: "#445566" }} />
      </div>
    </div>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  return { app, renderer: app.renderer, select: (index: number) => app.root.flushSync(() => setSelected(index)) }
}

/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer: TestRenderer, name: string): string {
  const file = path.join(shots, `${process.pid}-${name}.png`)
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

const sum = (reasons: string) => Object.values(JSON.parse(reasons) as Record<string, number>).reduce((a, b) => a + b, 0)

/** The selection moves along `WAY` (each a frame), seen after each move. */
const WAY = [1, 2, 5, 2, 0, 9, 3]

function run(variant: Variant, patch: boolean, shape: Shape = "hover") {
  const { app, renderer, select } = open(variant, shape)
  try {
    renderer.setPatchEnabled(patch)
    const detail = renderer.findByTestId("detail")!.id
    // A plain list does not scroll: the scroller read after the commit is the detail's.
    const list = shape === "plain" || shape === "nested" ? detail : renderer.findByTestId("list")!.id
    // The first frames record the rows with their hover styles; the way goes over them once.
    renderer.drawFrame()
    for (const index of WAY) {
      select(index)
      renderer.drawFrame()
    }
    const steps = []
    let mismatches = 0
    for (const [step, index] of WAY.entries()) {
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      renderer.resetBuildCounters()
      select(index)
      // What the mailbox does with every key: the detail goes to the top, where it is.
      renderer.scrollTo(detail, 0, 0)
      const passes = renderer.getLayoutPassCount()
      // What a handler reads after a commit: the offset and the height of the list.
      const metrics = renderer.getScrollMetrics(list)
      const forcedPass = renderer.getLayoutPassCount() - passes
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      steps.push({
        patched: after.patchedFrames - before.patchedFrames,
        whole: renderer.getPaintedFrameCount() - frames,
        built: renderer.getBuildCounters().elementsBuilt,
        forcedPass,
        metrics,
        unpatchable: sum(after.unpatchable) - sum(before.unpatchable),
        declines: sum(after.declines) - sum(before.declines),
        reasons: after.unpatchable,
        picture: picture(renderer, `${variant}-${shape}-${patch}-${step}`),
      })
      mismatches += renderer.getRetainedCounters().mismatches
    }
    return { steps, mismatches, patchCounters: renderer.getPatchCounters() }
  } finally {
    app.unmount()
  }
}

describe.skipIf(!hasNativeTestRenderer)("Solid: a commit that only paints", () => {
  test("builds the two rows it restyled and patches the frame, with no layout pass for a read after it", () => {
    const on = run("paint", true)
    expect(on.mismatches).toBe(0)
    if (!counted) return
    for (const [index, step] of on.steps.entries()) {
      expect(step.patched, `step ${index}: ${JSON.stringify(step.reasons)}`).toBe(1)
      expect(step.whole, `step ${index}`).toBe(0)
      expect(step.forcedPass, `step ${index}`).toBe(0)
      expect(step.unpatchable + step.declines).toBe(0)
      // The two rows the selection left and came to, each a div and a text.
      expect(step.built, `step ${index}`).toBe(4)
    }
  })

  for (const variant of ["paint", "opacity", "appear", "layout", "outside"] as const) {
    test(`${variant}: shows what patching off shows`, () => {
      const on = run(variant, true)
      const off = run(variant, false)
      expect(on.mismatches).toBe(0)
      expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
      expect(on.steps.map((step) => step.metrics)).toEqual(off.steps.map((step) => step.metrics))
      expect(off.patchCounters.patchedFrames).toBe(0)
    })
  }

  test("a style whose hover colour changes with the rest is no layout pass for a read", () => {
    // `rowStyle` to the selected style also changes the colour of the hover, which was a layout change.
    const { app, renderer, select } = open("paint")
    try {
      renderer.drawFrame()
      select(1)
      renderer.drawFrame()
      const passes = renderer.getLayoutPassCount()
      select(2)
      renderer.getScrollMetrics(renderer.findByTestId("list")!.id)
      expect(renderer.getLayoutPassCount() - passes).toBe(0)
    } finally {
      app.unmount()
    }
  })

  for (const variant of ["opacity", "appear", "layout"] as const) {
    test(`${variant}: is drawn whole, not patched`, () => {
      const on = run(variant, true)
      if (!counted) return
      for (const step of on.steps) {
        expect(step.patched).toBe(0)
        expect(step.whole).toBeGreaterThan(0)
      }
      // A commit that is not strict never asks for a patch, so none is counted as declined.
      expect(sum(on.patchCounters.unpatchable) + sum(on.patchCounters.declines)).toBe(0)
    })
  }

  test("outside: a restyled element no root holds is counted as Commit and drawn whole", () => {
    const on = run("outside", true)
    if (!counted) return
    for (const step of on.steps) {
      expect(step.patched).toBe(0)
      expect(step.whole).toBeGreaterThan(0)
    }
    const reasons = JSON.parse(on.patchCounters.unpatchable) as Record<string, number>
    expect(reasons.Commit).toBeGreaterThan(0)
  })

  // A row that declares no hover is a root a patch repaints when it is a row of a virtual list (what is in it is built whole already),
  // or when nothing in it is worth a root of its own and nothing runs in the window: the roots patching widens to.
  for (const [shape, built] of [["list", 4], ["plain", 6]] as const) {
    test(`${shape}: rows that declare no hover are patched, building the two rows`, () => {
      const on = run("paint", true, shape)
      const off = run("paint", false, shape)
      expect(on.mismatches).toBe(0)
      expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
      expect(on.steps.map((step) => step.metrics)).toEqual(off.steps.map((step) => step.metrics))
      expect(off.patchCounters.patchedFrames).toBe(0)
      if (!counted) return
      for (const [index, step] of on.steps.entries()) {
        expect(step.patched, `step ${index}: ${JSON.stringify(step.reasons)}`).toBe(1)
        expect(step.whole, `step ${index}`).toBe(0)
        expect(step.forcedPass, `step ${index}`).toBe(0)
        expect(step.unpatchable + step.declines).toBe(0)
        expect(step.built, `step ${index}`).toBe(built)
      }
    })
  }

  test("nested: a row with a root of its own in it is no patch root, so the restyle is counted as Commit and drawn whole", () => {
    const on = run("paint", true, "nested")
    const off = run("paint", false, "nested")
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    for (const step of on.steps) {
      expect(step.patched).toBe(0)
      expect(step.whole).toBeGreaterThan(0)
    }
    const reasons = JSON.parse(on.patchCounters.unpatchable) as Record<string, number>
    expect(reasons.Commit).toBeGreaterThan(0)
  })

  test("a root the list moved since it was recorded is declined as Commit:Relocated and drawn whole", () => {
    const run = (patch: boolean, declared: boolean) => {
      const { app, renderer, select } = open("paint")
      try {
        renderer.setPatchEnabled(patch)
        renderer.setListSizesEnabled(declared)
        const list = renderer.findByTestId("list")!.id
        renderer.drawFrame()
        for (const index of WAY) {
          select(index)
          renderer.drawFrame()
        }
        // The rows are built again where they stand after a scroll by a fraction of a row, and the frame after that is a translate.
        renderer.scrollTo(list, 0, 15)
        renderer.drawFrame()
        renderer.scrollTo(list, 0, 25)
        renderer.drawFrame()
        const before = renderer.getPatchCounters()
        select(4)
        renderer.drawFrame()
        const after = renderer.getPatchCounters()
        return {
          relocated: (JSON.parse(after.unpatchable)["Commit:Relocated"] ?? 0) - (JSON.parse(before.unpatchable)["Commit:Relocated"] ?? 0),
          patched: after.patchedFrames - before.patchedFrames,
          picture: picture(renderer, `relocated-${patch}`),
        }
      } finally {
        renderer.setListSizesEnabled(true)
        app.unmount()
      }
    }
    // The rows of the list are measured by layout, so the scrolls before it are built again where the rows stand.
    const on = run(true, false)
    expect(on.picture).toEqual(run(false, false).picture)
    if (counted) expect(on).toMatchObject({ relocated: 1, patched: 0 })
    // Told the sizes, the list translates those scrolls and the root is patched where it stands.
    const told = run(true, true)
    expect(told.picture).toEqual(run(false, true).picture)
    if (counted) expect(told).toMatchObject({ relocated: 0, patched: 1 })
  })
})
