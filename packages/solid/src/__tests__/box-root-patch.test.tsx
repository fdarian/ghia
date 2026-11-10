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

type Page = { title: string; headerHeight: number; row: string; footer: string }

function open(initial: Page) {
  const [page, setPage] = createSignal(initial)
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "column", width: 600, height: 400, backgroundColor: "#ffffff" }}>
      <div testId="header" style={{ display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0, height: page().headerHeight, padding: 12 }}>
        <input placeholder="Search" style={{ width: 120, height: 24, fontSize: 13, backgroundColor: "#f4f4f5" }} />
        <text style={{ marginLeft: 16, fontSize: 12, color: "#71717a", whiteSpace: "nowrap" }}>{page().title}</text>
      </div>
      <div testId="scroller" style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, overflowY: "auto" }}>
        <For each={Array.from({ length: ROWS }, (_, index) => index)}>
          {(index) => (
            <div
              testId={`row-${index}`}
              style={{ display: "flex", flexDirection: "row", alignItems: "center", flexShrink: 0, height: 48, paddingLeft: 16, backgroundColor: "#ffffff", hover: { backgroundColor: "#f4f4f5" } }}
            >
              <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
                <text style={{ fontSize: 14, color: "#18181b", whiteSpace: "nowrap" }}>{`Message ${index}`}</text>
                <text style={{ fontSize: 12, color: "#71717a", whiteSpace: "nowrap" }}>{index === 5 ? page().row : "preview"}</text>
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

const BASE: Page = { title: "230 items", headerHeight: 56, row: "a preview of the body", footer: "ready" }

function run(name: string, patch: boolean, changes: Partial<Page>[]) {
  const { app, renderer, set } = open(BASE)
  try {
    renderer.setPatchEnabled(patch)
    // The first frames record the page, and the first edit of a root that was recorded before it qualified is a frame built whole, which makes it.
    renderer.drawFrame()
    renderer.drawFrame()
    set({ title: "warm", row: "warm" })
    renderer.drawFrame()
    renderer.drawFrame()
    const steps = []
    for (const [step, change] of changes.entries()) {
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      set(change)
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      steps.push({
        patched: after.patchedFrames - before.patchedFrames,
        relaid: after.relayoutPatches - before.relayoutPatches,
        whole: renderer.getPaintedFrameCount() - frames,
        picture: picture(renderer, `${name}-${patch}-${step}`),
        header: boundsOf(renderer, "header"),
        row: boundsOf(renderer, "row-5"),
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
    // gpui drops the recording of a root a scroller moves (a row) when a patch lays it out again, so the edit after the first is a frame
    // built whole (`Anchor:StaleRecording`): only the first is a patch.
    expect(on.steps[0].relaid, JSON.stringify(on.counters)).toBe(1)
    expect(on.steps[0].whole).toBe(0)
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
