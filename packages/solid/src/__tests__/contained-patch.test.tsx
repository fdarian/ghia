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

function open(initial: Page, withList = false, onKey?: () => void): Open {
  const [page, setPage] = createSignal(initial)
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div
      testId="page"
      tabIndex={onKey ? 0 : undefined}
      onKeyDown={onKey}
      style={{ display: "flex", flexDirection: "row", width: 600, height: 400, backgroundColor: "#ffffff" }}
    >
      <div testId="sidebar" style={{ width: 120, flexShrink: 0, height: "100%", backgroundColor: "#f4f4f5" }}>
        <text style={{ color: "#18181b" }}>{page().side}</text>
        {withList && (
          <virtual-list testId="list" itemCount={40} estimatedItemHeight={30} overdraw={0} style={{ width: 120, height: 300, scrollbarWidth: "none" }}>
            <For each={Array.from({ length: 12 }, (_, index) => index)}>
              {(index) => (
                <div testId={`row-${index}`} style={{ width: 100, height: 30, flexShrink: 0, backgroundColor: index % 2 ? "#e4e4e7" : "#d4d4d8" }}>
                  <text style={{ fontSize: 12 }}>{`row ${index}`}</text>
                </div>
              )}
            </For>
          </virtual-list>
        )}
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

/** The boxes wrap in rows of two, three, one, three. */
const REWRAP: Partial<Page>[] = [{ box: 200 }, { box: 90 }, { box: 270 }, { box: 120 }]

describe.skipIf(!hasNativeTestRenderer)("Solid: a commit inside a scroller", () => {
  test("boxes that rewrap are each a relayout patch of the detail with no whole frame, and show what patching off shows", () => {
    const on = run("rewrap", true, REWRAP)
    const off = run("rewrap", false, REWRAP)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.bounds)).toEqual(off.steps.map((step) => step.bounds))
    expect(off.counters.patchedFrames).toBe(0)
    if (!counted) return
    // gpui keeps the recording of an anchor whose elements publish their boxes, as Ghia's all do (zed c4590da472): every change is a patch.
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0, 0])
    expect(reason(on.counters.unpatchable, "Anchor:StaleRecording")).toBe(0)
    expect(on.counters.rewrittenRecordings).toBe(4)
    // The first patch builds the detail and its six boxes, and the filler: no other element of the page.
    expect(on.steps[0].built).toBeLessThanOrEqual(10)
    expect(on.steps[0].built).toBeGreaterThan(0)
  })

  test("roots inside the anchor (a paragraph and a box with a text) are spliced: each commit is a relayout patch, and shows what patching off shows", () => {
    const rooted: Page = { ...BASE, rooted: true }
    const changes: Partial<Page>[] = [{ box: 200 }, { box: 90 }, { box: 270 }]
    const on = run("rooted", true, changes, {}, rooted)
    const off = run("rooted", false, changes, {}, rooted)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.bounds)).toEqual(off.steps.map((step) => step.bounds))
    if (!counted) return
    // Roots nested in the anchor (they have dispatch nodes) are spliced out and in.
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0])
    expect(sum(on.counters.declines)).toBe(0)
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

  test("keyed swaps of the detail's content with another number of elements are relayout patches, and show what patching off shows", () => {
    const changes: Partial<Page>[] = [{ count: 9 }, { count: 4 }, { count: 7 }]
    const on = run("swap", true, changes)
    const off = run("swap", false, changes)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0])
    expect(sum(on.counters.declines)).toBe(0)
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

/** The paragraphs each message of the mailbox page has: the detail is swapped between messages of other counts, as ghia-bench's mailbox is. */
const PARAGRAPHS: Record<number, number> = { 1: 3, 2: 6, 3: 2, 4: 5 }
const MESSAGES = [2, 3, 4]

type Mailbox = {
  app: ReturnType<typeof createTestRoot>
  renderer: TestRenderer
  select: (message: number) => void
  log: string[]
  host: (testId: string) => { getBoundingClientRect: () => unknown }
}

function openMailbox(): Mailbox {
  const [message, setMessage] = createSignal(1)
  const log: string[] = []
  const hosts = new Map<string, { getBoundingClientRect: () => unknown }>()
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "row", width: 600, height: 400, backgroundColor: "#ffffff" }}>
      <div testId="sidebar" style={{ width: 120, flexShrink: 0, height: "100%", backgroundColor: "#f4f4f5" }}>
        <div testId="inbox" tabIndex={0} style={{ width: 100, height: 28 }}>
          <text style={{ color: "#18181b" }}>Inbox</text>
        </div>
      </div>
      <div
        testId="detail"
        style={{ flexGrow: 1, minWidth: 0, height: "100%", padding: 16, overflowY: "auto", backgroundColor: "#ffffff" }}
      >
        <Show when={message()} keyed>
          {(current) => (
            <div testId={`message-${current}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <text style={{ fontSize: 16, color: "#18181b" }}>{`Message ${current}`}</text>
              <div
                testId={`reply-${current}`}
                tabIndex={0}
                ref={(element) => hosts.set(`reply-${current}`, element)}
                onClick={() => log.push(`click reply-${current}`)}
                onMouseEnter={() => log.push(`enter reply-${current}`)}
                style={{ width: 80, height: 28, backgroundColor: "#dbeafe" }}
              >
                <text style={{ fontSize: 12 }}>Reply</text>
              </div>
              <div
                testId={`tail-${current}`}
                ref={(element) => hosts.set(`tail-${current}`, element)}
                onClick={() => log.push(`click tail-${current}`)}
                style={{ width: 120, height: 32, backgroundColor: "#fee2e2" }}
              />
              <For each={Array.from({ length: PARAGRAPHS[current] }, (_, index) => index)}>
                {(index) => (
                  <text style={{ fontSize: 14, color: "#27272a" }}>{`${PARAGRAPH} `.repeat(1 + ((index + current) % 3))}</text>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>
    </div>
  ))
  app.renderer.setA11yActive(false)
  app.renderer.setInlineDraws(false)
  const host = (testId: string) => {
    const element = hosts.get(testId)
    if (!element) throw new Error(`no host element ${testId}`)
    return element
  }
  return { app, renderer: app.renderer, select: (next) => app.root.flushSync(() => setMessage(next)), log, host }
}

/** The detail goes through `MESSAGES`, a frame each; with `interact` the page is used after each frame, which is when a patch that left a
 *  stale hitbox, listener or tab stop shows. */
function runMailbox(patch: boolean, interact: boolean) {
  const { app, renderer, select, log, host } = openMailbox()
  try {
    renderer.setPatchEnabled(patch)
    renderer.drawFrame()
    renderer.drawFrame()
    const steps = []
    for (const message of MESSAGES) {
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      select(message)
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      const step = {
        patched: after.patchedFrames - before.patchedFrames,
        relaid: after.relayoutPatches - before.relayoutPatches,
        whole: renderer.getPaintedFrameCount() - frames,
        picture: picture(renderer, `mailbox-${patch}-${interact}-${message}`),
        reply: host(`reply-${message}`).getBoundingClientRect(),
        tail: host(`tail-${message}`).getBoundingClientRect(),
        detail: renderer.getScrollMetrics(renderer.findByTestId("detail")!.id),
        used: [] as string[],
        focused: "" as string | null,
      }
      if (interact) {
        const center = (testId: string): [number, number] => {
          const bounds = renderer.getElementBounds(renderer.findByTestId(testId)!.id)!
          return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
        }
        log.length = 0
        renderer.nativeSimulateMouseMove(300, 5)
        renderer.nativeSimulateMouseMove(...center(`reply-${message}`))
        renderer.nativeSimulateClick(...center(`reply-${message}`))
        renderer.nativeSimulateClick(...center(`tail-${message}`))
        renderer.focusElement(renderer.findByTestId("inbox")!.id)
        renderer.simulateKeystrokes("Tab")
        const focused = renderer.getFocusedElementId()
        step.focused = focused === null ? null : (renderer.getElement(focused)?.testId ?? null)
        step.used = [...log]
      }
      steps.push(step)
    }
    return { steps, mismatches: renderer.getRetainedCounters().mismatches, counters: renderer.getPatchCounters() }
  } finally {
    app.unmount()
  }
}

describe.skipIf(!hasNativeTestRenderer)("Solid: the detail of a mailbox swapped between messages", () => {
  test("swaps between messages of other paragraph counts are all patch frames and show what patching off shows", () => {
    const on = runMailbox(true, false)
    const off = runMailbox(false, false)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(on.steps.map((step) => step.reply)).toEqual(off.steps.map((step) => step.reply))
    expect(on.steps.map((step) => step.tail)).toEqual(off.steps.map((step) => step.tail))
    expect(on.steps.map((step) => step.detail)).toEqual(off.steps.map((step) => step.detail))
    if (!counted) return
    expect(on.steps.map((step) => step.relaid), JSON.stringify(on.counters)).toEqual([1, 1, 1])
    expect(on.steps.map((step) => step.whole)).toEqual([0, 0, 0])
    expect(sum(on.counters.declines)).toBe(0)
    expect(reason(on.counters.unpatchable, "Anchor:StaleRecording")).toBe(0)
  })

  test("a click and a hover on the new content reach its listeners, and Tab moves focus into it, after each patch", () => {
    const on = runMailbox(true, true)
    const off = runMailbox(false, true)
    expect(on.mismatches).toBe(0)
    for (const [index, message] of MESSAGES.entries()) {
      expect(on.steps[index].used).toEqual([`enter reply-${message}`, `click reply-${message}`, `click tail-${message}`])
      expect(on.steps[index].focused).toBe(`reply-${message}`)
    }
    expect(on.steps.map((step) => step.used)).toEqual(off.steps.map((step) => step.used))
    expect(on.steps.map((step) => step.reply)).toEqual(off.steps.map((step) => step.reply))
    if (!counted) return
    // Each swap is the frame the interaction before left: the first is a patch, whatever the clicks and the focus before it made.
    expect(on.steps[0].relaid, JSON.stringify(on.counters)).toBe(1)
  })
})

type Between = "nothing" | "second swap" | "outside change" | "detail scroll" | "list scroll"

/**
 * The detail is swapped, and what a handler reads right after is read: the scroll metrics of the detail, the box of an element in the new
 * content, the scroll offset and height of a list outside it. `between` is what the handler does after the reads and before the frame.
 */
function runReading(patch: boolean, changes: Partial<Page>[], between: Between, initial: Page = BASE) {
  const { app, renderer, set } = open(initial, true)
  try {
    renderer.setPatchEnabled(patch)
    renderer.drawFrame()
    renderer.drawFrame()
    const detail = renderer.findByTestId("detail")!.id
    const list = renderer.findByTestId("list")!.id
    const steps = []
    for (const [step, change] of changes.entries()) {
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      renderer.resetBuildCounters()
      const passes = renderer.getLayoutPassCount()
      set(change)
      const inside = renderer.findByTestId("box-5")?.id
      const reads = {
        detail: renderer.getScrollMetrics(detail),
        inside: inside === undefined ? null : renderer.getElementBounds(inside),
        list: renderer.getScrollMetrics(list),
      }
      const readPasses = renderer.getLayoutPassCount() - passes
      switch (between) {
        case "nothing":
          break
        case "second swap":
          set({ count: (change.count ?? 6) + 2 })
          break
        case "outside change":
          set({ side: `Folder ${step}` })
          break
        case "detail scroll":
          renderer.scrollTo(detail, 0, 20 + step * 10)
          break
        case "list scroll":
          renderer.scrollTo(list, 0, 60 + step * 30)
          break
      }
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      const last = renderer.findByTestId("box-5")?.id
      steps.push({
        reads,
        readPasses,
        patched: after.patchedFrames - before.patchedFrames,
        relaid: after.relayoutPatches - before.relayoutPatches,
        whole: renderer.getPaintedFrameCount() - frames,
        built: renderer.getBuildCounters().elementsBuilt,
        declines: sum(after.declines) - sum(before.declines),
        picture: picture(renderer, `reading-${between}-${patch}-${step}`),
        after: {
          detail: renderer.getScrollMetrics(detail),
          inside: last === undefined ? null : renderer.getElementBounds(last),
          list: renderer.getScrollMetrics(list),
        },
      })
    }
    return { steps, mismatches: renderer.getRetainedCounters().mismatches, counters: renderer.getPatchCounters() }
  } finally {
    app.unmount()
  }
}

const SWAPS: Partial<Page>[] = [{ count: 9 }, { count: 4 }, { count: 11 }]

describe.skipIf(!hasNativeTestRenderer)("Solid: a read while a commit inside a scroller is pending", () => {
  test("is answered by the patch of the detail, with no layout pass, and the draw finishes it without building the detail again", () => {
    const on = runReading(true, SWAPS, "nothing")
    const off = runReading(false, SWAPS, "nothing")
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.reads)).toEqual(off.steps.map((step) => step.reads))
    expect(on.steps.map((step) => step.after)).toEqual(off.steps.map((step) => step.after))
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    expect(off.counters.patchedFrames).toBe(0)
    // The read saw the new content: the box that was read is in a row further down than the first swap puts it.
    expect(on.steps[0].reads.inside).not.toBeNull()
    if (!counted) return
    for (const [index, step] of on.steps.entries()) {
      expect(step.readPasses, `step ${index}`).toBe(0)
      expect(step.relaid, `step ${index}: ${JSON.stringify(on.counters)}`).toBe(1)
      expect(step.whole, `step ${index}`).toBe(0)
      // The detail, its boxes and the filler, once: the read builds them and the draw does not.
      expect(step.built, `step ${index}`).toBe((SWAPS[index].count as number) + 2)
    }
    expect(sum(on.counters.declines)).toBe(0)
    expect(sum(on.counters.unpatchable)).toBe(0)
  })

  test("a second swap after the read throws the prepared patch away, and the frame is the one patching off draws", () => {
    const on = runReading(true, SWAPS, "second swap")
    const off = runReading(false, SWAPS, "second swap")
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.reads)).toEqual(off.steps.map((step) => step.reads))
    expect(on.steps.map((step) => step.after)).toEqual(off.steps.map((step) => step.after))
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    for (const [index, step] of on.steps.entries()) {
      expect(step.readPasses, `step ${index}`).toBe(0)
      // A discarded patch leaves the layout it computed in the engine and the recording of the anchor behind it: the frame is built whole
      // (gpui declines StaleRecording) and records the anchor again.
      expect(step.relaid, `step ${index}`).toBe(0)
      expect(step.whole, `step ${index}`).toBe(1)
    }
    expect(reason(on.counters.declines, "StaleRecording")).toBe(SWAPS.length)
  })

  for (const between of ["outside change", "detail scroll", "list scroll"] as const) {
    test(`${between} after the read throws the prepared patch away: the frame is drawn whole and is the one patching off draws`, () => {
      const on = runReading(true, SWAPS, between)
      const off = runReading(false, SWAPS, between)
      expect(on.mismatches).toBe(0)
      expect(on.steps.map((step) => step.reads)).toEqual(off.steps.map((step) => step.reads))
      expect(on.steps.map((step) => step.after)).toEqual(off.steps.map((step) => step.after))
      expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
      if (!counted) return
      for (const [index, step] of on.steps.entries()) {
        expect(step.readPasses, `step ${index}`).toBe(0)
        expect(step.patched, `step ${index}`).toBe(0)
        expect(step.whole, `step ${index}`).toBeGreaterThan(0)
      }
    })
  }

  test("a commit that is not contained (a detail as wide as its widest box) falls back to a layout pass for the read, and the values are right", () => {
    const leaks: Page = { ...BASE, leaks: true, box: 200 }
    const changes: Partial<Page>[] = [{ box: 260 }, { box: 150 }, { box: 220 }]
    const on = runReading(true, changes, "nothing", leaks)
    const off = runReading(false, changes, "nothing", leaks)
    expect(on.mismatches).toBe(0)
    expect(on.steps.map((step) => step.reads)).toEqual(off.steps.map((step) => step.reads))
    expect(on.steps.map((step) => step.after)).toEqual(off.steps.map((step) => step.after))
    expect(on.steps.map((step) => step.picture)).toEqual(off.steps.map((step) => step.picture))
    if (!counted) return
    for (const [index, step] of on.steps.entries()) {
      expect(step.readPasses, `step ${index}`).toBeGreaterThan(0)
      expect(step.patched, `step ${index}`).toBe(0)
      expect(step.whole, `step ${index}`).toBeGreaterThan(0)
    }
    expect(reason(on.counters.declines, "NotContained")).toBe(changes.length)
  })

  test("a key handler that swaps the detail and reads right after, inside the dispatch of the key, gets the new values with no layout pass", () => {
    const run = (patch: boolean) => {
      let renderer: TestRenderer | undefined
      let reads: unknown[] = []
      let swap: ((change: Partial<Page>) => void) | undefined
      let armed = false
      const handler = () => {
        if (!armed) return
        const current = renderer!
        swap!({ count: 9 })
        const inside = current.findByTestId("box-5")?.id
        reads = [
          current.getScrollMetrics(current.findByTestId("detail")!.id),
          inside === undefined ? null : current.getElementBounds(inside),
          current.getScrollMetrics(current.findByTestId("list")!.id),
        ]
      }
      const opened = open(BASE, true, handler)
      renderer = opened.renderer
      swap = opened.set
      try {
        renderer.setPatchEnabled(patch)
        renderer.drawFrame()
        renderer.drawFrame()
        renderer.focusElement(renderer.findByTestId("page")!.id)
        // The first key after a focus that was not made by a key turns the focus ring on, which redraws the page: it is not the key under test.
        renderer.simulateKeystrokes("F2")
        renderer.drawFrame()
        renderer.drawFrame()
        armed = true
        const passes = renderer.getLayoutPassCount()
        // The test window draws at the end of the key's dispatch, where a patch is not made (gpui draws a tick whole inside a dispatch): the
        // frame is one built whole, which shows what the prepared patch laid out, and the live window draws the tick after the dispatch.
        renderer.simulateKeystrokes("F2")
        const readPasses = renderer.getLayoutPassCount() - passes
        renderer.drawFrame()
        return {
          reads,
          readPasses,
          picture: picture(renderer, `key-${patch}`),
          mismatches: renderer.getRetainedCounters().mismatches,
        }
      } finally {
        opened.app.unmount()
      }
    }
    const on = run(true)
    const off = run(false)
    expect(on.mismatches).toBe(0)
    expect(on.reads).toEqual(off.reads)
    expect(on.picture).toEqual(off.picture)
    expect(on.reads[1]).not.toBeNull()
    if (!counted) return
    expect(on.readPasses).toBe(0)
  })
})
