/// The caret of an editing host, from the real paint pipeline: where it is, when it is shown, how it blinks and what a blink
/// costs a frame (a patch that builds the paragraph that holds it, as the caret of an `<input>` does). Menlo has one advance for
/// every character, so a position is a column.
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

// Under the retention verifier a frame builds everything it compares, and with retention or patching off no frame is a patch.
const counted = it.skipIf(
  process.env.GPUIX_RETAIN_VERIFY !== undefined || process.env.GPUIX_RETAIN_OFF !== undefined || process.env.GPUIX_PATCH_OFF !== undefined
)

const LINE = 20
const TEXT = { fontSize: 16, lineHeight: `${LINE}px`, fontFamily: "Menlo" } as const
const BLINK = 500
const CARET_WIDTH = 2

function measureColumn(): number {
  const root = createTestRoot()
  root.render(
    <div highlight={{ query: "aaaaaaaaaa" }}>
      <div style={TEXT}>{"aaaaaaaaaa"}</div>
    </div>
  )
  const width = root.renderer.getPaintedHighlights()[0]!.rects[0]!.width / 10
  root.unmount()
  return width
}

const COLUMN = measureColumn()

/** The microtask in which the queue flushes a selection that changed outside a commit. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function shown(renderer: { drawFrame(): void }): Promise<void> {
  await settle()
  renderer.drawFrame()
  renderer.drawFrame()
}

describeNative("the caret of an editing host (React)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** An editing host with a paragraph for each line (`null` is an empty one, `<br>`), in a box of a fixed size. */
  function mount(lines: Array<string | null>, width = 400) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    root.render(
      <div style={{ padding: 20, ...TEXT }}>
        <div contentEditable style={{ width, height: 300 }}>
          {lines.map((line, index) => (
            <div key={index}>{line === null ? <br /> : line}</div>
          ))}
        </div>
      </div>
    )
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    const paragraphs = [...host.children] as HTMLElement[]
    const renderer = root.renderer
    renderer.setA11yActive(false)
    renderer.setInlineDraws(false)
    renderer.clockPause()
    const rect = host.getBoundingClientRect()
    return { host, paragraphs, texts: paragraphs.map((child) => child.firstChild as Text), renderer, left: rect.x, top: rect.y }
  }

  async function focused(lines: Array<string | null>, width?: number) {
    const mounted = mount(lines, width)
    mounted.host.focus()
    mounted.renderer.dispatchNativeEvents()
    return mounted
  }

  describe("where it is", () => {
    it("is at the offset in a text, a line high and 2px wide, lit when it comes", async () => {
      const { texts, renderer, left, top } = await focused(["hello world", "second"])
      document.getSelection().collapse(texts[0]!, 3)
      await shown(renderer)
      const painted = renderer.getPaintedNodeSelection()
      expect(painted.washes).toEqual([])
      const caret = painted.caret!
      expect(caret.rect.x).toBeCloseTo(left + 3 * COLUMN, 1)
      expect(caret.rect.y).toBeCloseTo(top, 1)
      expect(caret.rect.width).toBeCloseTo(CARET_WIDTH, 1)
      expect(caret.rect.height).toBeCloseTo(LINE, 1)
      expect(caret.lit).toBe(true)

      document.getSelection().collapse(texts[1]!, 6)
      await shown(renderer)
      const moved = renderer.getPaintedNodeSelection().caret!
      expect(moved.rect.x).toBeCloseTo(left + 6 * COLUMN, 1)
      expect(moved.rect.y).toBeCloseTo(top + LINE, 1)
    })

    it("is on the row the offset wraps to", async () => {
      const { texts, renderer, left, top } = await focused(["aaaa bbbb cccc dddd"], 10 * COLUMN + 0.5)
      document.getSelection().collapse(texts[0]!, 12)
      await shown(renderer)
      const caret = renderer.getPaintedNodeSelection().caret!
      expect(caret.rect.x).toBeCloseTo(left + 2 * COLUMN, 1)
      expect(caret.rect.y).toBeCloseTo(top + LINE, 1)
      document.getSelection().collapse(texts[0]!, 4)
      await shown(renderer)
      const first = renderer.getPaintedNodeSelection().caret!
      expect(first.rect.x).toBeCloseTo(left + 4 * COLUMN, 1)
      expect(first.rect.y).toBeCloseTo(top, 1)
    })

    it("is at the start of an empty paragraph that holds only a <br>, where JS puts it at the element", async () => {
      const { paragraphs, renderer, left, top } = await focused(["one", null, "three"])
      document.getSelection().collapse(paragraphs[1]!, 0)
      await shown(renderer)
      const caret = renderer.getPaintedNodeSelection().caret!
      expect(caret.rect.x).toBeCloseTo(left, 1)
      expect(caret.rect.y).toBeCloseTo(top + LINE, 1)
      expect(caret.rect.height).toBeCloseTo(LINE, 1)
    })

    it("is between two <br>, at the element boundary that no text is next to", async () => {
      const root = createTestRoot({ width: 600, height: 400 })
      cleanups.push(() => root.unmount())
      root.render(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 400, height: 300 }}>
            <div>
              {"ab"}
              <br />
              <br />
              {"cd"}
            </div>
          </div>
        </div>
      )
      const host = document.body!.querySelector("[contenteditable]") as HTMLElement
      const paragraph = host.firstElementChild as HTMLElement
      const renderer = root.renderer
      renderer.setInlineDraws(false)
      host.focus()
      renderer.dispatchNativeEvents()
      const { x, y } = host.getBoundingClientRect()
      document.getSelection().collapse(paragraph, 2)
      await shown(renderer)
      const caret = renderer.getPaintedNodeSelection().caret!
      expect(caret.rect.x).toBeCloseTo(x, 1)
      expect(caret.rect.y).toBeCloseTo(y + LINE, 1)
    })
  })

  describe("when it is shown", () => {
    it("is hidden while the selection is not collapsed, and back when it is", async () => {
      const { texts, renderer } = await focused(["first line", "second line"])
      const selection = document.getSelection()
      selection.collapse(texts[0]!, 2)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret).toBeDefined()
      selection.setBaseAndExtent(texts[0]!, 2, texts[1]!, 3)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret).toBeUndefined()
      expect(renderer.getPaintedNodeSelection().washes).toHaveLength(2)
      selection.collapse(texts[1]!, 3)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret).toBeDefined()
    })

    it("is hidden while the host has no focus, shown when it takes it, and hidden when it loses it", async () => {
      const { host, texts, renderer } = mount(["first line"])
      const selection = document.getSelection()
      selection.collapse(texts[0]!, 2)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret, "no focus").toBeUndefined()
      host.focus()
      renderer.dispatchNativeEvents()
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret, "focus").toBeDefined()
      host.blur()
      renderer.dispatchNativeEvents()
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret, "blur").toBeUndefined()
    })

    it("is hidden while the window is not key", async () => {
      const { texts, renderer } = await focused(["first line"])
      document.getSelection().collapse(texts[0]!, 2)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret).toBeDefined()
      renderer.setWindowActive(false)
      renderer.dispatchNativeEvents()
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret).toBeUndefined()
      renderer.setWindowActive(true)
      renderer.dispatchNativeEvents()
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret).toBeDefined()
    })

    it("follows the text it is in when that is edited", async () => {
      const { texts, renderer, left } = await focused(["abc"])
      document.getSelection().collapse(texts[0]!, 3)
      await shown(renderer)
      texts[0]!.insertData(3, "def")
      document.getSelection().collapse(texts[0]!, 6)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().caret!.rect.x).toBeCloseTo(left + 6 * COLUMN, 1)
    })
  })

  describe("how it blinks", () => {
    it("is lit for a phase, then in no colour for one, and solid again whenever the selection moves", async () => {
      const { texts, renderer } = await focused(["first line"])
      const selection = document.getSelection()
      selection.collapse(texts[0]!, 2)
      await shown(renderer)
      const lit = () => renderer.getPaintedNodeSelection().caret!.lit
      expect(lit()).toBe(true)
      renderer.advanceTime(BLINK - 1)
      renderer.drawFrame()
      expect(lit(), "just before the end of the phase").toBe(true)
      renderer.advanceTime(1)
      renderer.drawFrame()
      expect(lit(), "at the end of it").toBe(false)
      renderer.advanceTime(BLINK)
      renderer.drawFrame()
      expect(lit()).toBe(true)
      renderer.advanceTime(BLINK)
      renderer.drawFrame()
      expect(lit()).toBe(false)
      selection.collapse(texts[0]!, 4)
      await shown(renderer)
      expect(lit(), "a move starts the phase over").toBe(true)
      renderer.advanceTime(BLINK - 1)
      renderer.drawFrame()
      expect(lit()).toBe(true)
    })

    it("asks for no frame while the host has no focus or the window is not key", async () => {
      const { host, texts, renderer } = mount(["first line"])
      document.getSelection().collapse(texts[0]!, 2)
      await shown(renderer)
      const idle = renderer.getPaintedFrameCount()
      renderer.advanceTime(BLINK)
      renderer.advanceTime(BLINK)
      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount() - idle, "no focus").toBe(0)
      host.focus()
      renderer.dispatchNativeEvents()
      await shown(renderer)
      renderer.setWindowActive(false)
      renderer.dispatchNativeEvents()
      await shown(renderer)
      const inactive = renderer.getPaintedFrameCount()
      renderer.advanceTime(BLINK)
      renderer.advanceTime(BLINK)
      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount() - inactive, "window not key").toBe(0)
    })

    counted("blinks in patched frames that build the paragraph that holds the caret and nothing else", async () => {
      const lines = Array.from({ length: 40 }, (_, index) => `paragraph number ${index}`)
      const { texts, renderer } = await focused(lines)
      document.getSelection().collapse(texts[5]!, 4)
      await shown(renderer)
      await shown(renderer)
      // The first change of phase builds the paragraph, which a frame that replays it never did again: that is a frame built whole, and
      // what makes the paragraph a unit for the ticks after it.
      renderer.advanceTime(BLINK)
      renderer.drawFrame()
      const phases: Array<{ built: number; patched: number }> = []
      const before = renderer.getPatchCounters()
      for (let phase = 0; phase < 6; phase++) {
        renderer.resetBuildCounters()
        const patched = renderer.getPatchCounters().patchedFrames
        renderer.advanceTime(BLINK)
        renderer.drawFrame()
        phases.push({ built: renderer.getBuildCounters().elementsBuilt, patched: renderer.getPatchCounters().patchedFrames - patched })
        // The warm-up blink put the caret out.
        expect(renderer.getPaintedNodeSelection().caret!.lit, `phase ${phase}`).toBe(phase % 2 === 0)
      }
      const after = renderer.getPatchCounters()
      expect(after.declines, "gpui declines no blink").toBe(before.declines)
      expect(after.unpatchable, "no blink is left unpatched").toBe(before.unpatchable)
      for (const [phase, done] of phases.entries()) {
        expect(done.patched, `phase ${phase} is one patched frame`).toBe(1)
        // The paragraph and nothing of the 39 others.
        expect(done.built, `phase ${phase} builds the paragraph alone`).toBeLessThanOrEqual(2)
      }
    })
  })
})
