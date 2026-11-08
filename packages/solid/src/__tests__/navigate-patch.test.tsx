/**
 * One key of ghia-bench's mailbox is one draw (patch-frames.md, "Patch and translate in one draw"): the rows the selection leaves and
 * comes to are restyled, the detail is swapped for the content of the new message, the handler reads layout (which prepares the patch of
 * the detail), and the list scrolls to bring the new row in. The prepared patch is finished, the restyles are patches, and the rows are
 * moved by a translate that builds the row that came in, with no frame built whole. The picture, the boxes and the scroll metrics are
 * what patching off, and the translate off, show.
 *
 * Rows of 40 in a list of 300 (it shows seven and a half), every row measured first: a row that has no measured size is a whole frame.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, Show, createSignal } from "solid-js"
import { describe, expect, it } from "bun:test"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"
import type { StyleDesc } from "@ghia/native"

// Under the retention verifier a frame that replays roots is built a second time and that build is the frame shown, and a patch is
// compared with the frame built whole after it: the counters that tell a patch from a frame built whole are skipped there.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined && process.env.GPUIX_SCROLL_PATCH_OFF === undefined
const counted = patching && !verifying
// The verifier describes the scene a patch wrote in place before the splice of a relayout patch of the same patch changes it, so a patch
// of a row and of the detail together reads as a mismatch of the frame built whole (zed `window/patch.rs`, `PatchTrace::in_place_scene`).
// Under it the detail keeps its message, and the keys restyle the rows and move the list as they do.
const swapping = !verifying

const TIMEOUT = 60_000
const test = (name: string, run: () => void) => it(name, run, TIMEOUT)

const COUNT = 60
const ROW = 40
const VIEW = 300
const PARAGRAPH = "The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly over the sleepy cat"
const shots = fs.mkdtempSync(path.join(os.tmpdir(), "navigate-patch-"))

const rowStyle = (selected: boolean): StyleDesc => ({
  width: 150,
  height: ROW,
  flexShrink: 0,
  borderBottom: "1px solid #112233",
  backgroundColor: selected ? "#335577" : "#223344",
})

/** Where the list scrolls to for the row `index` to be at its bottom, as a key that reveals the selection does. */
const revealing = (index: number) => Math.max(0, (index + 1) * ROW - VIEW)

type Mode = "whole" | "no-translate" | "on"

function open(overdraw: number) {
  const [selected, setSelected] = createSignal(6)
  const [tint, setTint] = createSignal("#ffffff")
  const indices = Array.from({ length: COUNT }, (_, index) => index)
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "row", width: 600, height: 400, backgroundColor: tint() }}>
      <virtual-list
        testId="list"
        itemCount={COUNT}
        estimatedItemHeight={ROW}
        overdraw={overdraw}
        style={{ width: 200, height: VIEW, flexShrink: 0, scrollbarWidth: "none" }}
      >
        <For each={indices}>
          {(index) => (
            <div testId={`row-${index}`} style={rowStyle(selected() === index)}>
              <text style={{ color: "#ffffff" }}>{`row-${index}`}</text>
            </div>
          )}
        </For>
      </virtual-list>
      <div
        testId="detail"
        style={{ flexGrow: 1, minWidth: 0, height: "100%", padding: 16, overflowY: "auto", backgroundColor: "#ffffff" }}
      >
        <Show when={swapping ? selected() : 6} keyed>
          {(current) => (
            <div testId={`message-${current}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <text style={{ fontSize: 16, color: "#18181b" }}>{`Message ${current}`}</text>
              <For each={Array.from({ length: 2 + (current % 4) }, (_, index) => index)}>
                {(index) => <text style={{ fontSize: 14, color: "#27272a" }}>{`${PARAGRAPH} `.repeat(1 + ((index + current) % 3))}</text>}
              </For>
            </div>
          )}
        </Show>
      </div>
    </div>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  return {
    app,
    renderer: app.renderer,
    select: (index: number) => app.root.flushSync(() => setSelected(index)),
    paint: (color: string) => app.root.flushSync(() => setTint(color)),
  }
}

/** The frame that was drawn last as it is: `captureScreenshot` refreshes the window and would capture a frame built whole. */
function picture(renderer: TestRenderer, name: string): string {
  const file = path.join(shots, `${process.pid}-${name}.png`)
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

/** The counters that are not zero, which is what says why a frame was not the one expected. */
function nonzero(counters: ReturnType<TestRenderer["getPatchCounters"]>): string {
  const nonzeroOf = (record: Record<string, number>) => Object.fromEntries(Object.entries(record).filter(([, count]) => count !== 0))
  return JSON.stringify({
    declines: nonzeroOf(JSON.parse(counters.declines)),
    unpatchable: JSON.parse(counters.unpatchable),
    reasons: nonzeroOf(counters.scrollPatch.reasons),
    held: nonzeroOf(counters.scrollPatch.held),
    apply: nonzeroOf(counters.scrollPatch.applyDeclines),
  })
}

const sum = (reasons: string) => Object.values(JSON.parse(reasons) as Record<string, number>).reduce((a, b) => a + b, 0)
const reason = (reasons: string, key: string) => (JSON.parse(reasons) as Record<string, number>)[key] ?? 0

type Key = {
  /** The row the selection moves to. */
  to: number
  /** What the handler reads of the layout after it commits: the detail's metrics and the box of the new message. */
  read: boolean
  /** Where the list scrolls to after the reads, if it does. */
  scroll?: number
  /** The page behind the rows changes colour, which no unit holds: a frame built whole, which replays the rows where the scrolls put them. */
  paint?: string
}

/** The keys one after another, each a draw, seen after each. */
function run(mode: Mode, overdraw: number, keys: Key[]) {
  const { app, renderer, select, paint } = open(overdraw)
  try {
    renderer.setPatchEnabled(mode !== "whole")
    const list = renderer.findByTestId("list")!.id
    const detail = renderer.findByTestId("detail")!.id
    renderer.drawFrame()
    renderer.drawFrame()
    // Every row measured, by showing every row once. A frame the translate is off for records no list to move the rows of, so the
    // translate is on from the start (the rows that are not measured are frames built whole anyway).
    renderer.setScrollPatchEnabled(mode === "on")
    for (let at = 0; at <= COUNT * ROW - VIEW; at += 20) {
      renderer.scrollTo(list, 0, at)
      renderer.drawFrame()
    }
    renderer.scrollTo(list, 0, 0)
    renderer.drawFrame()
    const steps = []
    for (const [step, key] of keys.entries()) {
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      renderer.resetBuildCounters()
      select(key.to)
      const passes = renderer.getLayoutPassCount()
      const reads = key.read
        ? {
            detail: renderer.getScrollMetrics(detail),
            message: renderer.getElementBounds(renderer.findByTestId(`message-${swapping ? key.to : 6}`)!.id),
          }
        : undefined
      const readPasses = renderer.getLayoutPassCount() - passes
      if (key.scroll !== undefined) renderer.scrollTo(list, 0, key.scroll)
      if (key.paint !== undefined) paint(key.paint)
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      const rows = Object.fromEntries(
        [key.to - 1, key.to, key.to + 1].map((index) => [index, renderer.getElementBounds(renderer.findByTestId(`row-${index}`)!.id)]),
      )
      steps.push({
        patched: after.patchedFrames - before.patchedFrames,
        relaid: after.relayoutPatches - before.relayoutPatches,
        whole: renderer.getPaintedFrameCount() - frames,
        translated: after.scrollPatch.patched - before.scrollPatch.patched,
        membership: after.scrollPatch.membershipFrames - before.scrollPatch.membershipFrames,
        composed: after.scrollPatch.composed - before.scrollPatch.composed,
        rowsBuilt: after.scrollPatch.rowsBuilt - before.scrollPatch.rowsBuilt,
        rowsRebuilt: after.scrollPatch.rowsRebuilt - before.scrollPatch.rowsRebuilt,
        declines: sum(after.declines) - sum(before.declines),
        unpatchable: sum(after.unpatchable) - sum(before.unpatchable),
        readPasses,
        reads,
        picture: picture(renderer, `${mode}-${overdraw}-${step}`),
        list: renderer.getScrollMetrics(list),
        detail: renderer.getScrollMetrics(detail),
        rows,
      })
    }
    return { steps, mismatches: renderer.getRetainedCounters().mismatches, counters: renderer.getPatchCounters() }
  } finally {
    app.unmount()
  }
}

/** Seven and a half rows show; the first key brings row 7 fully in, and each after it a row in at the bottom and one out at the top. */
const NAVIGATE: Key[] = [7, 8, 9, 10].map((to) => ({ to, read: true, scroll: revealing(to) }))
/** The rows were recorded at the top: by the fifth key they have moved by more than the overscan their recording was made with (half the list). */
const DRIFTED: Key[] = [...NAVIGATE, { to: 11, read: true, scroll: revealing(11) }]
const THEN_WHOLE: Key[] = [...DRIFTED, { to: 11, read: false, paint: "#fafafa" }, { to: 12, read: true, scroll: revealing(12) }]

const same = (on: ReturnType<typeof run>, off: ReturnType<typeof run>) => {
  expect(on.mismatches).toBe(0)
  expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
  expect(on.steps.map((step) => step.list)).toEqual(off.steps.map((step) => step.list))
  expect(on.steps.map((step) => step.detail)).toEqual(off.steps.map((step) => step.detail))
  for (const [index, step] of on.steps.entries()) expect(step.rows, `step ${index}: patched ${JSON.stringify(step.rows)} whole ${JSON.stringify(off.steps[index].rows)}`).toEqual(off.steps[index].rows)
  expect(on.steps.map((step) => step.reads)).toEqual(off.steps.map((step) => step.reads))
}

describe.skipIf(!hasNativeTestRenderer)("Solid: a key of the mailbox is one draw", () => {
  test("the restyles, the swap of the detail and the scroll that brings the row in are a patch and a translate with membership, and no frame is built whole", () => {
    const on = run("on", 0, NAVIGATE)
    same(on, run("whole", 0, NAVIGATE))
    same(on, run("no-translate", 0, NAVIGATE))
    if (!counted) return
    for (const [index, step] of on.steps.entries()) {
      const where = `step ${index}: ${JSON.stringify({ ...step, picture: undefined, reads: undefined })} ${nonzero(on.counters)}`
      expect(step.readPasses, where).toBe(0)
      expect(step.patched, where).toBe(1)
      expect(step.relaid, where).toBe(1)
      expect(step.whole, where).toBe(0)
      expect(step.translated, where).toBe(1)
      expect(step.composed, where).toBe(1)
      expect(step.declines + step.unpatchable, where).toBe(0)
    }
    // The first key moves the rows without bringing one in (row 7 is the half row at the bottom), the others bring one in.
    expect(on.steps.map((step) => step.membership)).toEqual([0, 1, 1, 1])
    expect(on.steps.map((step) => step.rowsBuilt)).toEqual([0, 1, 1, 1])
  })

  test("rows that moved by more than the overscan of their recording are built again where they are in the same translate, showing what patching off shows", () => {
    const on = run("on", 0, DRIFTED)
    same(on, run("whole", 0, DRIFTED))
    if (!counted) return
    expect(on.steps.slice(0, 4).map((step) => step.rowsRebuilt)).toEqual([0, 0, 0, 0])
    for (const [index, step] of on.steps.entries()) {
      const where = `step ${index}: ${nonzero(on.counters)}`
      expect(step.whole, where).toBe(0)
      expect(step.composed, where).toBe(1)
      expect(step.declines + step.unpatchable, where).toBe(0)
    }
    // The rows were recorded at the top, and the fifth key has moved them by 200: past the 150 their recordings cover.
    expect(on.steps[4].rowsRebuilt, nonzero(on.counters)).toBeGreaterThan(0)
    expect(on.steps[4].rowsBuilt).toBeGreaterThan(on.steps[4].rowsRebuilt)
    expect(on.counters.scrollPatch.held["Region"]).toBe(0)
  })

  test("a frame built whole after keys replays the rows where the patches and the scrolls left them, and the keys after it are the same", () => {
    const on = run("on", 0, THEN_WHOLE)
    same(on, run("whole", 0, THEN_WHOLE))
    if (!counted) return
    expect(on.steps[5].whole).toBe(1)
    // The frame built whole at the fifth key records the rows where the list is.
    expect(on.steps[6].composed, nonzero(on.counters)).toBe(1)
  })

  test("a key that does not scroll the list is a patch with no translate", () => {
    const keys: Key[] = [{ to: 5, read: true }, { to: 4, read: true }, { to: 6, read: false }]
    const on = run("on", 0, keys)
    same(on, run("whole", 0, keys))
    if (!counted) return
    for (const [index, step] of on.steps.entries()) {
      expect(step.patched, `step ${index}`).toBe(1)
      expect(step.whole, `step ${index}`).toBe(0)
      expect(step.translated, `step ${index}`).toBe(0)
      expect(step.declines + step.unpatchable, `step ${index}: ${nonzero(on.counters)}`).toBe(0)
    }
  })

  test("a restyled row that is not in the frame needs no unit: the key is a patch, and the row is built with its new style when a scroll brings it in", () => {
    // Row 9 is below the rows built (overdraw 0 builds the rows that show): selecting it repaints the row 6 left and nothing else.
    const keys: Key[] = [{ to: 9, read: true }, { to: 9, read: false, scroll: revealing(9) }]
    const on = run("on", 0, keys)
    same(on, run("whole", 0, keys))
    if (!counted) return
    expect(on.steps[0].patched, nonzero(on.counters)).toBe(1)
    expect(on.steps[0].whole).toBe(0)
    expect(on.steps[0].declines + on.steps[0].unpatchable).toBe(0)
    expect(reason(on.counters.unpatchable, "Commit")).toBe(0)
    expect(reason(on.counters.unpatchable, "Read:Commit")).toBe(0)
    // The scroll of the second key is a translate that builds the rows 8 and 9 (and takes out the first two): the frame is not built whole.
    expect(on.steps[1].whole, nonzero(on.counters)).toBe(0)
    expect(on.steps[1].translated).toBe(1)
  })

  test("a scroll that cannot be a translate (more than half the list) leaves the patch and a frame built whole that shows the new offset", () => {
    const keys: Key[] = [{ to: 7, read: true, scroll: revealing(7) }, { to: 30, read: true, scroll: revealing(30) }, { to: 8, read: true, scroll: revealing(8) }]
    const on = run("on", 0, keys)
    same(on, run("whole", 0, keys))
    expect(on.steps[1].list?.[1]).toBe(revealing(30))
    if (!counted) return
    expect(on.steps[1].translated).toBe(0)
    expect(on.steps[1].whole).toBeGreaterThan(0)
    expect(on.steps[1].composed).toBe(0)
  })

  test("a scroll write with no commit is a translate that notifies no view, and with the translate off it is a frame built whole at the new offset", () => {
    const keys: Key[] = [60, 100, 140, 120].map((at, index) => ({ to: 6, read: false, scroll: at + index }))
    const on = run("on", 0, keys)
    same(on, run("whole", 0, keys))
    same(on, run("no-translate", 0, keys))
    expect(on.steps.map((step) => step.list?.[1])).toEqual(keys.map((key) => key.scroll))
    if (!counted) return
    expect(on.steps.map((step) => step.translated)).toEqual([1, 1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0, 0])
  })

  test("a restyled row in the overdraw of the list (built, not painted) is patched and moved with the rest: the key is shown as patching off shows it", () => {
    // Overdraw 120 builds the rows below the ones that show, and the rows 9 and 10 are among them.
    const keys: Key[] = [{ to: 9, read: true, scroll: revealing(9) }, { to: 10, read: true, scroll: revealing(10) }]
    const on = run("on", 120, keys)
    same(on, run("whole", 120, keys))
    if (!counted) return
    for (const [index, step] of on.steps.entries()) {
      const where = `step ${index}: ${nonzero(on.counters)}`
      expect(step.patched, where).toBe(1)
      expect(step.whole, where).toBe(0)
      expect(step.composed, where).toBe(1)
      expect(step.declines + step.unpatchable, where).toBe(0)
    }
    expect(reason(on.counters.declines, "UnknownUnit")).toBe(0)
  })
})
