/**
 * A key handler that swaps a subtree out and then reads layout (patch-frames.md, "Reads"; forced-reads.md, "A removed node is out of the
 * tree at the read"). The detached subtree is out of the frame: the stylesheets stop matching its elements (a node out of the document has
 * no rules), and that restyle is no change of the frame, so it is no `Structure` the read has to decline. Content styled by classes
 * and content styled inline swap the same way: the read prepares the patch of the detail, and no frame is built whole.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, Show, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { insertHostNode, removeHostNode } from "../host.js"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
const patching = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined
// Under the verifier a patch is compared with the frame built whole after it: the counters that tell the two apart are skipped there.
const counted = patching && !verifying

const TIMEOUT = 60_000
const test = (name: string, run: () => void) => it(name, run, TIMEOUT)

const COUNT = 30
const ROW = 40
const VIEW = 300
const PARAGRAPH = "The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly over the sleepy cat"

const SHEET = `
  .row { width: 150px; height: ${ROW}px; flex-shrink: 0; background-color: #223344; border-bottom: 1px solid #112233 }
  .row.selected { background-color: #335577 }
  .detail { flex-grow: 1; min-width: 0; height: 100%; padding: 16px; overflow-y: auto; background-color: #ffffff }
  .message { display: flex; flex-direction: column; gap: 8px }
  .title { font-size: 16px; color: #18181b }
  .paragraph { font-size: 14px; color: #27272a }
`

type Styling = "class" | "inline"

const inline = {
  message: { display: "flex", flexDirection: "column", gap: 8 },
  title: { fontSize: 16, color: "#18181b" },
  paragraph: { fontSize: 14, color: "#27272a" },
} as const

function open(styling: Styling) {
  const [selected, setSelected] = createSignal(2)
  const indices = Array.from({ length: COUNT }, (_, index) => index)
  const app = createTestRoot({ width: 600, height: 400 })
  let detail!: HostElement
  let list!: HostElement
  const byClass = styling === "class"
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "row", width: 600, height: 400, backgroundColor: "#ffffff" }}>
      <style>{SHEET}</style>
      <virtual-list
        ref={list}
        testId="list"
        itemCount={COUNT}
        estimatedItemHeight={ROW}
        overdraw={0}
        style={{ width: 200, height: VIEW, flexShrink: 0, scrollbarWidth: "none" }}
      >
        <For each={indices}>
          {(index) => (
            <div testId={`row-${index}`} class={selected() === index ? "row selected" : "row"}>
              <div style={{ color: "#ffffff" }}>{`row-${index}`}</div>
            </div>
          )}
        </For>
      </virtual-list>
      <div ref={detail} testId="detail" class="detail">
        <Show when={selected()} keyed>
          {(current) => (
            <div testId={`message-${current}`} class={byClass ? "message" : undefined} style={byClass ? undefined : inline.message}>
              <div class={byClass ? "title" : undefined} style={byClass ? undefined : inline.title}>{`Message ${current}`}</div>
              <For each={Array.from({ length: 2 + (current % 4) }, (_, index) => index)}>
                {(index) => (
                  <div class={byClass ? "paragraph" : undefined} style={byClass ? undefined : inline.paragraph}>
                    {`${PARAGRAPH} `.repeat(1 + ((index + current) % 3))}
                  </div>
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
  return { app, renderer: app.renderer, detail, list, next: () => setSelected(selected() + 1) }
}

const sum = (counts: string) => Object.values(JSON.parse(counts) as Record<string, number>).reduce((a, b) => a + b, 0)
const unpatchable = (renderer: TestRenderer) => JSON.parse(renderer.getPatchCounters().unpatchable) as Record<string, number>

/** The keys one after another, each a draw: the handler selects the next row, which swaps the detail, and reads the detail's metrics before it returns. */
function navigate(styling: Styling, keys: number, patch = true) {
  const { app, renderer, detail, list, next } = open(styling)
  try {
    renderer.clockPause()
    renderer.setPatchEnabled(patch)
    renderer.setScrollPatchEnabled(patch)
    renderer.drawFrame()
    renderer.drawFrame()
    // Every row measured, by showing every row once: a row with no measured size is a frame built whole.
    for (let at = 0; at <= COUNT * ROW - VIEW; at += 20) {
      renderer.scrollTo(list.nativeId, 0, at)
      renderer.drawFrame()
    }
    renderer.scrollTo(list.nativeId, 0, 0)
    renderer.drawFrame()
    const steps = []
    for (let key = 0; key < keys; key++) {
      const before = renderer.getPatchCounters()
      const frames = renderer.getPaintedFrameCount()
      const unpatchableBefore = unpatchable(renderer)
      // What a key handler does: write the signal, then read layout before the handler returns. The read applies the mutations
      // queued so far (the detach of the old detail, the restyles of the sheets), and the old detail is destroyed only in a later batch.
      next()
      const keyReads = { scrollTop: detail.scrollTop, clientHeight: detail.clientHeight, scrollHeight: detail.scrollHeight }
      renderer.drawFrame()
      const after = renderer.getPatchCounters()
      const unpatchableAfter = unpatchable(renderer)
      steps.push({
        metrics: keyReads,
        patched: after.patchedFrames - before.patchedFrames,
        whole: renderer.getPaintedFrameCount() - frames,
        declines: sum(after.declines) - sum(before.declines),
        structure: (unpatchableAfter["Read:Structure"] ?? 0) - (unpatchableBefore["Read:Structure"] ?? 0),
        unpatchable: sum(after.unpatchable) - sum(before.unpatchable),
        counters: JSON.stringify({ declines: JSON.parse(after.declines), unpatchable: unpatchableAfter }),
      })
    }
    return steps
  } finally {
    app.unmount()
  }
}

describe.skipIf(!hasNativeTestRenderer)("Solid: a read after a swap leaves the detached subtree out of the frame", () => {
  for (const styling of ["class", "inline"] as const) {
    test(`a key that swaps ${styling}-styled content and reads the detail is a patch: no Structure decline and no frame built whole`, () => {
      const steps = navigate(styling, 4)
      // Whatever patching does, the reads answer the new content's layout.
      for (const step of steps) {
        expect(step.metrics!.clientHeight).toBeGreaterThan(0)
        expect(step.metrics!.scrollHeight).toBeGreaterThanOrEqual(step.metrics!.clientHeight)
      }
      if (!counted) return
      for (const [index, step] of steps.entries()) {
        const where = `step ${index}: ${JSON.stringify({ ...step, metrics: undefined, counters: undefined })} ${step.counters}`
        expect(step.structure, where).toBe(0)
        expect(step.unpatchable, where).toBe(0)
        expect(step.patched, where).toBe(1)
        expect(step.whole, where).toBe(0)
      }
    })
  }

  test("class-styled content swapped out and read gives the layout patching off gives", () => {
    const patched = navigate("class", 4)
    const whole = navigate("class", 4, false)
    expect(patched.map((step) => step.metrics)).toEqual(whole.map((step) => step.metrics))
  })
})

describe.skipIf(!hasNativeTestRenderer)("Solid: a detached subtree is matched again when it is put back", () => {
  const CARD_SHEET = `
    .pane { width: 120px; height: 100px; flex-shrink: 0 }
    .card { width: 100px; height: 30px; background-color: #ff0000 }
    .card .label { width: 40px; height: 10px; background-color: #0000ff }
    .second .card { background-color: #00ff00 }
    .second .card .label { background-color: #ffff00 }
  `
  const scene = (parentOf: "first" | "second") => {
    const app = createTestRoot({ width: 300, height: 200 })
    let first!: HostElement
    let second!: HostElement
    let card!: HostElement
    let label!: HostElement
    app.render(() => (
      <div style={{ display: "flex", flexDirection: "row", width: 300, height: 200, backgroundColor: "#ffffff" }}>
        <style>{CARD_SHEET}</style>
        <div ref={first} class="pane first">
          {parentOf === "first" ? (
            <div ref={card} class="card">
              <div ref={label} class="label" />
            </div>
          ) : null}
        </div>
        <div ref={second} class="pane second">
          {parentOf === "second" ? (
            <div ref={card} class="card">
              <div ref={label} class="label" />
            </div>
          ) : null}
        </div>
      </div>
    ))
    app.renderer.setA11yActive(false)
    app.renderer.setInlineDraws(false)
    app.renderer.drawFrame()
    return { app, first, second, card, label }
  }

  const colors = (card: HostElement, label: HostElement) => [getComputedStyle(card).backgroundColor, getComputedStyle(label).backgroundColor]

  const picture = (shown: ReturnType<typeof scene>) => {
    const file = path.join(os.tmpdir(), `detached-restyle-${process.pid}-${Math.random().toString(36).slice(2)}.png`)
    shown.app.renderer.captureShownFrame(file)
    const bytes = fs.readFileSync(file)
    fs.rmSync(file, { force: true })
    return bytes.toString("base64")
  }

  test("the card put under the other pane is restyled by the rules of its new place and paints with them", () => {
    // What a card that was under the second pane from the start shows.
    const reference = scene("second")
    expect(colors(reference.card, reference.label)).toEqual(["rgb(0, 255, 0)", "rgb(255, 255, 0)"])
    const referencePicture = picture(reference)
    const referenceX = reference.card.getBoundingClientRect().x
    reference.app.unmount()

    const moved = scene("first")
    try {
      expect(colors(moved.card, moved.label)).toEqual(["rgb(255, 0, 0)", "rgb(0, 0, 255)"])
      removeHostNode(moved.first, moved.card)
      // A read applies the detach: the card is out of the document, and has no rules.
      expect(moved.first.getBoundingClientRect().width).toBe(120)
      expect(getComputedStyle(moved.card).backgroundColor).toBe("")
      insertHostNode(moved.second, moved.card, null)
      moved.app.root.flush()
      expect(colors(moved.card, moved.label)).toEqual(["rgb(0, 255, 0)", "rgb(255, 255, 0)"])
      moved.app.renderer.drawFrame()
      expect(moved.card.getBoundingClientRect().x).toBe(referenceX)
      expect(picture(moved)).toEqual(referencePicture)
    } finally {
      moved.app.unmount()
    }
  })

  test("the card put back under the pane it left matches the rules it had", () => {
    const { app, first, card, label } = scene("first")
    try {
      removeHostNode(first, card)
      expect(first.getBoundingClientRect().width).toBe(120)
      insertHostNode(first, card, null)
      app.root.flush()
      expect(colors(card, label)).toEqual(["rgb(255, 0, 0)", "rgb(0, 0, 255)"])
      app.renderer.drawFrame()
      expect(card.getBoundingClientRect().width).toBe(100)
    } finally {
      app.unmount()
    }
  })
})
