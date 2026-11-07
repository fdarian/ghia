/**
 * A commit whose layout and structure changes all lie inside a scroller (an anchor) is drawn as a relayout patch of that scroller: the
 * scroller is built again and laid out, gpui accepts the patch when nothing outside it moved, and no whole frame is built
 * (patch-frames.md, "Contained-layout patches"). A commit that leaks out of the scroller, lies outside every anchor or cannot be
 * repeated by the patch is drawn whole, and what the page shows is what patching off shows. A page with a sidebar and a detail
 * scroller like the Detail of ghia-bench's mailbox (`flexGrow: 1`, `minWidth: 0`, `height: 100%`, `overflowY: auto`).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, Show, createSignal } from "solid-js"
import { describe, expect, it } from "bun:test"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

// Under the retention verifier a frame that replays roots is built a second time and that build is the frame shown, and a patch is
// compared with the frame built whole after it: the counters that tell a patch from a frame built whole are skipped there.
const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined
const counted = patching && !verifying

const TIMEOUT = 60_000
const test = (name: string, run: () => void) => it(name, run, TIMEOUT)

const shots = fs.mkdtempSync(path.join(os.tmpdir(), "contained-patch-"))

const PARAGRAPH = "The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly over the sleepy cat"

type Page = {
  /** The width of each box in the detail, which wrap in rows of the detail's width. */
  box: number
  /** What the sidebar says, which no anchor holds. */
  side: string
  /** The detail is as wide as its widest box, so a box that changes width changes the detail's own box and what is beside it. */
  leaks: boolean
  /** The boxes in the keyed content of the detail. */
  count: number
  /** The detail holds a paragraph and a box around a paragraph, which are roots of their own that the frame built whole records. */
  rooted: boolean
}

type Open = { app: ReturnType<typeof createTestRoot>; renderer: TestRenderer; set: (change: Partial<Page>) => void }

function open(initial: Page): Open {
  const [page, setPage] = createSignal(initial)
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "row", width: 600, height: 400, backgroundColor: "#ffffff" }}>
      <div testId="sidebar" style={{ width: 120, flexShrink: 0, height: "100%", backgroundColor: "#f4f4f5" }}>
        <text style={{ color: "#18181b" }}>{page().side}</text>
      </div>
      <div
        testId="detail"
        style={
          page().leaks
            ? { flexGrow: 0, height: "100%", padding: 16, overflowY: "auto", backgroundColor: "#ffffff" }
            : {
                flexGrow: 1,
                minWidth: 0,
                height: "100%",
                padding: 16,
                overflowY: "auto",
                display: "flex",
                flexDirection: "row",
                flexWrap: "wrap",
                alignContent: "flex-start",
                gap: 8,
                backgroundColor: "#ffffff",
              }
        }
      >
        <Show when={page().count} keyed>
          {(count) => (
            <For each={Array.from({ length: count }, (_, index) => index)}>
              {(index) => (
                <div
                  testId={`box-${index}`}
                  style={{ width: page().box, height: 24, flexShrink: 0, backgroundColor: index % 2 ? "#dbeafe" : "#fee2e2" }}
                />
              )}
            </For>
          )}
        </Show>
        <Show when={page().rooted}>
          <text style={{ fontSize: 14, color: "#27272a", width: 280 }}>{PARAGRAPH}</text>
          <div style={{ width: 80, height: 40, backgroundColor: "#f0fdf4" }}>
            <text style={{ fontSize: 12 }}>root</text>
          </div>
        </Show>
        <div style={{ width: 8, height: 400, flexShrink: 0 }} />
      </div>
    </div>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  return { app, renderer: app.renderer, set: (change) => app.root.flushSync(() => setPage((before) => ({ ...before, ...change }))) }
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
const reason = (reasons: string, key: string) => (JSON.parse(reasons) as Record<string, number>)[key] ?? 0

const BASE: Page = { box: 120, side: "Inbox", leaks: false, count: 6, rooted: false }

type Options = { a11y?: boolean; readAfterCommit?: boolean }

/** The page goes through `changes`, each a frame, and what each frame was is seen after it. */
function run(name: string, patch: boolean, changes: Partial<Page>[], options: Options = {}, initial: Page = BASE) {
  const { app, renderer, set } = open(initial)
  try {
    renderer.setPatchEnabled(patch)
    renderer.setA11yActive(options.a11y ?? false)
    // The first frames record the page; the anchors are made by a frame built whole.
    renderer.drawFrame()
    renderer.drawFrame()
    const detail = renderer.findByTestId("detail")!.id
    const box = renderer.findByTestId("box-5")!.id
    const steps = []
    for (const [step, change] of changes.entries()) {
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      renderer.resetBuildCounters()
      set(change)
      const read = options.readAfterCommit
        ? { box: renderer.getElementBounds(box), detail: renderer.getElementBounds(detail), metrics: renderer.getScrollMetrics(detail) }
        : undefined
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      steps.push({
        patched: after.patchedFrames - before.patchedFrames,
        relaid: after.relayoutPatches - before.relayoutPatches,
        whole: renderer.getPaintedFrameCount() - frames,
        built: renderer.getBuildCounters().elementsBuilt,
        picture: picture(renderer, `${name}-${patch}-${step}`),
        read,
        bounds: { box: renderer.getElementBounds(box), detail: renderer.getElementBounds(detail), metrics: renderer.getScrollMetrics(detail) },
      })
    }
    return { steps, mismatches: renderer.getRetainedCounters().mismatches, counters: renderer.getPatchCounters() }
  } finally {
    app.unmount()
  }
}

/** The boxes wrap in rows of two, three, one, three. A second change in a row is drawn whole (the recording gpui keeps of the anchor is dropped), so each
 *  run of the patching tests starts from a frame built whole: the changes alternate with one that is not in an anchor. */
const REWRAP: Partial<Page>[] = [{ box: 200 }, { box: 90 }, { box: 270 }, { box: 120 }]

describe.skipIf(!hasNativeTestRenderer)("Solid: a commit inside a scroller", () => {
  test("boxes that rewrap are a relayout patch of the detail with no whole frame, and show what patching off shows", () => {
    const on = run("rewrap", true, REWRAP)
    const off = run("rewrap", false, REWRAP)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.bounds)).toEqual(off.steps.map((step) => step.bounds))
    expect(off.counters.patchedFrames).toBe(0)
    if (!counted) return
    // gpui keeps no recording of an anchor a patch laid out until a frame is built whole: the first change is a patch and the one after it
    // is the frame that records the anchor again (`Anchor:StaleRecording`), then the next is a patch again.
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 0, 1, 0])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 1, 0, 1])
    expect(reason(on.counters.unpatchable, "Anchor:StaleRecording")).toBe(2)
    // The first patch builds the detail and its six boxes, and the filler: no other element of the page.
    expect(on.steps[0].built).toBeLessThanOrEqual(10)
    expect(on.steps[0].built).toBeGreaterThan(0)
  })

  test("roots inside the anchor (a paragraph and a box with a text) make gpui decline Registrations until it splices them", () => {
    const rooted: Page = { ...BASE, rooted: true }
    const changes: Partial<Page>[] = [{ box: 200 }, { box: 90 }]
    const on = run("rooted", true, changes, {}, rooted)
    const off = run("rooted", false, changes, {}, rooted)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    expect(on.steps.map((step) => step.patched)).toEqual([0, 0])
    expect(reason(on.counters.declines, "Registrations")).toBe(2)
  })

  test("a leak: a detail as wide as its widest box moves what is beside it, so the patch declines NotContained and the frame is built whole", () => {
    const leaks: Page = { ...BASE, leaks: true, box: 200 }
    const changes: Partial<Page>[] = [{ box: 260 }, { box: 150 }, { box: 220 }]
    const on = run("leak", true, changes, {}, leaks)
    const off = run("leak", false, changes, {}, leaks)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.bounds)).toEqual(off.steps.map((step) => step.bounds))
    if (!counted) return
    for (const step of on.steps) {
      expect(step.patched).toBe(0)
      expect(step.whole).toBeGreaterThan(0)
    }
    expect(reason(on.counters.declines, "NotContained")).toBeGreaterThan(0)
  })

  test("a change outside every anchor is counted as Structure and drawn whole", () => {
    const changes: Partial<Page>[] = [{ side: "Starred" }, { side: "Sent" }, { side: "Drafts" }]
    const on = run("outside", true, changes)
    const off = run("outside", false, changes)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    for (const step of on.steps) {
      expect(step.patched).toBe(0)
      expect(step.whole).toBeGreaterThan(0)
    }
    expect(reason(on.counters.unpatchable, "Structure")).toBe(changes.length)
  })

  test("a keyed swap of the detail's content with another number of elements declines safely and is drawn whole", () => {
    const changes: Partial<Page>[] = [{ count: 9 }, { count: 4 }, { count: 7 }]
    const on = run("swap", true, changes)
    const off = run("swap", false, changes)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    // Another number of operations, hitboxes and registrations is what gpui's patch cannot yet splice (zed slice Z2): the key moves
    // to a patch when it can.
    for (const step of on.steps) {
      expect(step.patched).toBe(0)
      expect(step.whole).toBeGreaterThan(0)
    }
    // The hitboxes are counted first: a box more or less is a hitbox more or less.
    expect(reason(on.counters.declines, "Hitboxes"), JSON.stringify(on.counters)).toBe(changes.length)
    expect(sum(on.counters.declines)).toBe(changes.length)
  })

  test("with an accessibility tree built, a patch that lays out declines and the frame is built whole", () => {
    const on = run("a11y", true, REWRAP, { a11y: true })
    const off = run("a11y", false, REWRAP, { a11y: true })
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    for (const step of on.steps) {
      expect(step.patched).toBe(0)
      expect(step.whole).toBeGreaterThan(0)
    }
    expect(reason(on.counters.declines, "LayoutMismatch")).toBe(REWRAP.length)
  })

  test("a read of boxes and scroll metrics right after the commit returns what the commit made", () => {
    const on = run("read", true, REWRAP, { readAfterCommit: true })
    const off = run("read", false, REWRAP, { readAfterCommit: true })
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.read)).toEqual(off.steps.map((step) => step.read))
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    // Boxes of 200 wide go one to a row in a detail of 456, so the fourth is further down than at 120, where three fit in a row: the read saw the new layout.
    const tops = on.steps.map((step) => step.read?.box?.y ?? 0)
    expect(tops[0]).not.toBe(tops[3])
  })
})
