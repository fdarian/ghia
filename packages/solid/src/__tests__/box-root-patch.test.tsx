/**
 * A layout edit inside a box whose own border box its content cannot change (a definite height, and a width that is definite or stretched
 * across a block or column parent) is a relayout patch of that box, though no scroller holds it: a fixed-size header, a fixed-height row of a
 * scroller too big to be an anchor (patch-frames.md, "Box roots"). An edit that does change the box is declined by gpui (`NotContained`) and
 * the frame is built whole in the same draw. What the page shows is what patching off shows.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined && process.env.GPUIX_BOX_ROOTS_OFF === undefined
const counted = patching && !verifying

const TIMEOUT = 120_000
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "box-root-patch-"))

/** Rows of five elements each: more than an anchor holds (1024), so the scroller is no anchor and the rows are the roots. */
const ROWS = Number(process.env.ROWS ?? "230")

/** The row whose preview shows `Page.row` in the scrolled cases, far enough down that the scroller has to be moved to show it. */
const WATCHED_FAR = 30
const WHEEL_TICK = 30

type Page = { title: string; headerHeight: number; row: string; footer: string; shift: number; appended: number }

function open(initial: Page, watched: number, rows: number) {
  const [page, setPage] = createSignal(initial)
  // A `white-space` declared on an element that comes changes the text of everything below it, which no element is named for: a row appended
  // with one is a frame built whole, so the rows appended by the anchor case declare none.
  const nowrap = (index: number) => (index < rows ? ("nowrap" as const) : undefined)
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "column", width: 600, height: 400, backgroundColor: "#ffffff" }}>
      <div testId="header" style={{ display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0, height: page().headerHeight, padding: 12 }}>
        <input placeholder="Search" style={{ width: 120, height: 24, fontSize: 13, backgroundColor: "#f4f4f5" }} />
        <text style={{ marginLeft: 16, fontSize: 12, color: "#71717a", whiteSpace: "nowrap" }}>{page().title}</text>
      </div>
      <div testId="scroller" style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, overflowY: "auto" }}>
        <For each={Array.from({ length: rows + page().appended }, (_, index) => index)}>
          {(index) => (
            <div
              testId={index === watched ? `row-${index}` : undefined}
              style={{ display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0, height: 48, paddingLeft: 16, backgroundColor: "#ffffff", hover: { backgroundColor: "#f4f4f5" } }}
            >
              <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
                <text style={{ fontSize: 14, color: "#18181b", whiteSpace: nowrap(index) }}>{`Message ${index}`}</text>
                <text style={{ fontSize: 12, color: "#71717a", whiteSpace: nowrap(index), marginTop: index === watched ? page().shift : 0 }}>{index === watched ? page().row : "preview"}</text>
              </div>
              <text style={{ width: 72, fontSize: 12, color: "#2563eb", textAlign: "right" }}>{`r${index}`}</text>
            </div>
          )}
        </For>
      </div>
      <text testId="footer" style={{ fontSize: 12, color: "#71717a" }}>{page().footer}</text>
    </div>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  return { app, renderer: app.renderer, set: (change: Partial<Page>) => app.root.flushSync(() => setPage((before) => ({ ...before, ...change }))) }
}

function picture(renderer: TestRenderer, name: string): string {
  const file = path.join(shots, `${process.pid}-${name}.png`)
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function boundsOf(renderer: TestRenderer, testId: string) {
  const element = renderer.findByTestId(testId)
  if (!element) throw new Error(`no element ${testId}`)
  return renderer.getElementBounds(element.id)
}

const reason = (reasons: string, key: string) => (JSON.parse(reasons) as Record<string, number>)[key] ?? 0

const BASE: Page = { title: "230 items", headerHeight: 56, row: "a preview of the body", footer: "ready", shift: 0, appended: 0 }

type Scrolled = { top: number; tickBetweenEdits: boolean }

function run(name: string, patch: boolean, changes: Partial<Page>[], scrolled?: Scrolled, rows = ROWS) {
  const watched = scrolled ? WATCHED_FAR : 5
  const { app, renderer, set } = open(BASE, watched, rows)
  try {
    renderer.setPatchEnabled(patch)
    renderer.clockPause()
    const scroller = renderer.findByTestId("scroller")
    if (!scroller) throw new Error("no scroller")
    let direction = 1
    const tick = () => {
      renderer.dispatchScrollWheel(300, 200, 0, direction * WHEEL_TICK, undefined, "moved")
      direction = -direction
      for (let frame = 0; frame < 3; frame++) {
        renderer.clockAdvance(1000 / 120)
        renderer.drawFrame()
      }
    }
    // The first frames record the page, and the first edit of a root that was recorded before it qualified is a frame built whole, which makes it.
    renderer.drawFrame()
    renderer.drawFrame()
    if (scrolled) {
      renderer.scrollTo(scroller.id, undefined, scrolled.top)
      renderer.drawFrame()
      renderer.drawFrame()
      // A wheel tick puts every row where it was not recorded: the rows are replays with a delta from here on.
      tick()
    }
    set({ title: "warm", row: "warm" })
    renderer.drawFrame()
    renderer.drawFrame()
    const steps = []
    for (const [step, change] of changes.entries()) {
      if (scrolled?.tickBetweenEdits) tick()
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      const built = renderer.getBuildCounters().elementsBuilt
      set(change)
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      steps.push({
        built: renderer.getBuildCounters().elementsBuilt - built,
        patched: after.patchedFrames - before.patchedFrames,
        relaid: after.relayoutPatches - before.relayoutPatches,
        whole: renderer.getPaintedFrameCount() - frames,
        picture: picture(renderer, `${name}-${patch}-${step}`),
        header: boundsOf(renderer, "header"),
        row: boundsOf(renderer, `row-${watched}`),
        scrollTop: renderer.getScrollMetrics(scroller.id)?.[1],
      })
    }
    return { steps, mismatches: renderer.getRetainedCounters().mismatches, counters: renderer.getPatchCounters() }
  } finally {
    app.unmount()
  }
}

describe.skipIf(!hasNativeTestRenderer)("Solid: a commit inside a box of a fixed size", () => {
  it("a text edit in a fixed-size header is a relayout patch of the header, and shows what patching off shows", () => {
    const changes: Partial<Page>[] = [{ title: "231 items, edit 1" }, { title: "231 items, edit 2, a longer label" }, { title: "9" }]
    const on = run("header", true, changes)
    const off = run("header", false, changes)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.header)).toEqual(off.steps.map((step) => step.header))
    if (!counted) return
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0])
    expect(reason(on.counters.unpatchable, "Structure")).toBe(0)
  }, TIMEOUT)

  it("a text edit in a fixed-height row of a scroller too big to be an anchor is a relayout patch of the row", () => {
    const changes: Partial<Page>[] = [{ row: "edit 1" }, { row: "edit 2, a much longer preview of the body" }, { row: "" }]
    const on = run("row", true, changes)
    const off = run("row", false, changes)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.row)).toEqual(off.steps.map((step) => step.row))
    if (!counted) return
    // gpui rewrites the recording of a root a scroller moves (a row) after a patch lays it out again, so every edit is a patch.
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0])
    expect(reason(on.counters.unpatchable, "Structure")).toBe(0)
    expect(reason(on.counters.unpatchable, "Box:StaleRecording")).toBe(0)
  }, TIMEOUT)

  it("a text edit in a fixed-height row of a scroller small enough to be an anchor is a relayout patch of the row, not of the anchor", () => {
    const rows = 100
    const changes: Partial<Page>[] = [{ row: "edit 1" }, { row: "edit 2, a much longer preview of the body" }, { row: "" }]
    const on = run("anchor", true, changes, undefined, rows)
    const off = run("anchor", false, changes, undefined, rows)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.row)).toEqual(off.steps.map((step) => step.row))
    if (!counted) return
    // The row is a root of its own inside the anchor, so an edit builds the row (5 elements) and not the 501 of the scroller.
    for (const step of on.steps) {
      expect(step.relaid, JSON.stringify(on.counters)).toBe(1)
      expect(step.whole).toBe(0)
      expect(step.built, JSON.stringify(on.counters)).toBeLessThan(20)
    }
    // The one Structure is the edit that warms the page up: the header is no box root before a frame built whole has judged it.
    expect(reason(on.counters.unpatchable, "Structure")).toBe(1)
  }, TIMEOUT)

  // Skipped under the retention verifier: with patching off too (`GPUIX_PATCH_OFF=1 GPUIX_RETAIN_VERIFY=1`) a frame built whole after a row was
  // edited to an empty text and a row was appended to an anchor replays a root that differs from a build; with `GPUIX_ANCHORS_OFF=1` it does not.
  // Not the patch's. The row edits alone above run under it.
  it.skipIf(verifying)("a row appended after rows were patched is drawn whole: gpui forgot the recording of the anchor around the patched rows", () => {
    const rows = 100
    const changes: Partial<Page>[] = [{ row: "edit 1" }, { row: "edit 2, a much longer preview of the body" }, { row: "" }, { appended: 1 }, { appended: 1, row: "edit 5" }]
    const on = run("anchor-stale", true, changes, undefined, rows)
    const off = run("anchor-stale", false, changes, undefined, rows)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.row)).toEqual(off.steps.map((step) => step.row))
    if (!counted) return
    const [first, second, third, append, after] = on.steps
    for (const step of [first, second, third, after]) {
      expect(step?.relaid, JSON.stringify(on.counters)).toBe(1)
      expect(step?.whole).toBe(0)
    }
    // A child added to the scroller is the anchor's, which is declined before anything is built (its recording is gone), and the frame built
    // whole records the anchor again, so the edit after it is a patch of the row.
    expect(append?.patched).toBe(0)
    expect(append?.whole, JSON.stringify(on.counters)).toBe(1)
    expect(reason(on.counters.unpatchable, "Anchor:StaleRecording")).toBe(1)
  }, TIMEOUT)

  // Skipped under the retention verifier, as the one above: an anchor patch of this page is reported there with patching on and
  // not with `GPUIX_ANCHORS_OFF=1` (an off-screen row the patch paints and a frame built whole culls).
  it.skipIf(verifying)("a row appended to a scroller small enough to be an anchor is a patch of the anchor, and the edit of a row after it is drawn whole", () => {
    const rows = 100
    const changes: Partial<Page>[] = [{ appended: 1 }, { appended: 2 }, { appended: 2, row: "edit 3" }, { appended: 3 }]
    const on = run("anchor-append", true, changes, undefined, rows)
    const off = run("anchor-append", false, changes, undefined, rows)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.row)).toEqual(off.steps.map((step) => step.row))
    if (!counted) return
    const [first, second, edit] = on.steps
    // The anchor holds what no row does, and builds all of it (100 rows of 5 elements).
    for (const step of [first, second]) {
      expect(step?.relaid, JSON.stringify(on.counters)).toBe(1)
      expect(step?.whole).toBe(0)
      expect(step?.built).toBeGreaterThan(400)
    }
    // What a patch of the anchor laid out is of the layout before: the rows in it are no root to patch until a frame built whole has made them.
    expect(edit?.patched).toBe(0)
    expect(reason(on.counters.unpatchable, "Anchor:StaleRecording")).toBeGreaterThan(0)
  }, TIMEOUT)

  it("a text edit in a row of a scroller that was scrolled and then moved by a wheel tick is a relayout patch of the row", () => {
    const changes: Partial<Page>[] = [{ row: "edit 1" }, { row: "edit 2, a much longer preview of the body" }, { row: "" }, { row: "edit 4" }]
    const scrolled: Scrolled = { top: 1400, tickBetweenEdits: false }
    const on = run("scrolled", true, changes, scrolled)
    const off = run("scrolled", false, changes, scrolled)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.row)).toEqual(off.steps.map((step) => step.row))
    if (!counted) return
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0, 0])
    // The one Structure is the edit that warms the page up: the first edit of a row a wheel put elsewhere is a frame built whole.
    expect(reason(on.counters.unpatchable, "Structure")).toBe(1)
    expect(reason(on.counters.unpatchable, "Box:Relocated")).toBe(0)
  }, TIMEOUT)

  it("a row that a patch rewrote and a wheel tick then moved is edited by a patch every time, and no frame shows anything but what patching off shows", () => {
    const changes: Partial<Page>[] = [{ row: "edit 1" }, { row: "edit 2, a much longer preview of the body" }, { row: "" }, { row: "edit 4" }, { row: "edit 5" }]
    const scrolled: Scrolled = { top: 1400, tickBetweenEdits: true }
    const on = run("scrolled-ticks", true, changes, scrolled)
    const off = run("scrolled-ticks", false, changes, scrolled)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.row)).toEqual(off.steps.map((step) => step.row))
    if (!counted) return
    // The tick after a patch moves the row away from where gpui rewrote its recording, and the frame that tick builds
    // builds the row again (its record is of the build before the edit) while the scroller moves it: recorded all the same,
    // so the row is a box root of the frame shown, and every edit is a patch.
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0, 0, 0])
    for (const step of on.steps) expect(step.patched + step.whole).toBe(1)
    expect(reason(on.counters.declines, "Relocated")).toBe(0)
    expect(reason(on.counters.unpatchable, "Box:Relocated")).toBe(0)
  }, TIMEOUT)

  // Skipped under the retention verifier: with patching off too (`GPUIX_PATCH_OFF=1 GPUIX_RETAIN_VERIFY=1`) a frame that anchoring scrolls
  // replays a row whose published box is the scroll's distance (6 px) from the one a build gives, so the verifier reports it. Not the patch's.
  it.skipIf(verifying)("an edit inside a row that moves the box a scroller anchors to (scroll anchoring, the default) leaves the offset and the picture that patching off does", () => {
    // The scroller sits at 1450 after the wheel tick, which is 10 px into the watched row: the preview text, fully in view, is the anchor,
    // and `shift` moves it inside a row that keeps its box. A frame built whole scrolls by what moved the anchor; a patch has to as well.
    const changes: Partial<Page>[] = [{ shift: 6 }, { shift: 0 }, { shift: 12 }, { row: "edit 4", shift: 12 }]
    const scrolled: Scrolled = { top: 1420, tickBetweenEdits: false }
    const on = run("anchored", true, changes, scrolled)
    const off = run("anchored", false, changes, scrolled)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.scrollTop)).toEqual(off.steps.map((step) => step.scrollTop))
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.row)).toEqual(off.steps.map((step) => step.row))
    if (!counted) return
    // The anchor is inside the row and `shift` moves it, so the patch is declined and the frame built whole scrolls the scroller (the offset
    // moves 1450 -> 1447 and back). Whether the edit after the declines is a patch is the retention's (`Sourced`, `Hover:Relocated`), not anchoring's.
    expect(on.steps[0]?.whole, JSON.stringify(on.counters)).toBeGreaterThan(0)
    expect(on.steps[0]?.patched).toBe(0)
    expect(reason(on.counters.declines, "NotContained")).toBeGreaterThan(0)
  }, TIMEOUT)

  it("an edit that changes the box (the header's height) is declined NotContained and the frame is built whole", () => {
    const changes: Partial<Page>[] = [{ headerHeight: 64 }, { headerHeight: 40 }, { headerHeight: 56 }]
    const on = run("grow", true, changes)
    const off = run("grow", false, changes)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.header)).toEqual(off.steps.map((step) => step.header))
    if (!counted) return
    for (const step of on.steps) {
      expect(step.patched).toBe(0)
      expect(step.whole).toBeGreaterThan(0)
    }
    expect(reason(on.counters.declines, "NotContained")).toBeGreaterThan(0)
  }, TIMEOUT)

  it("an edit outside every box root (a text with no fixed size) is counted as Structure and drawn whole", () => {
    const changes: Partial<Page>[] = [{ footer: "saved" }, { footer: "saving" }]
    const on = run("footer", true, changes)
    const off = run("footer", false, changes)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    expect(reason(on.counters.unpatchable, "Structure")).toBe(changes.length)
  }, TIMEOUT)
})
