/**
 * What one typed character costs, from the real path: a key the platform's text input receives, the `editinput` event it sends,
 * the edit JS makes in the DOM, and the batch that carries it back (patch-frames.md, "An editing host's caret is a tick" and
 * "Box roots"). Counts are per character, in the steady state: the first character of a host is a frame built whole that records
 * what the later ones patch.
 *
 * A key is a keydown, the frame it asks for, then a keyup, as in a live window, where the display link draws between them.
 * `simulateKeystrokes` sends both in one call, and a simulated input draws the window as it ends, so the keyup draws the frame the
 * keydown asked for whole, not as the patch it would have been (the last test).
 */
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { decodeWireBatchForTest } from "@ghia/native/testing"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const verifying = process.env.GPUIX_RETAIN_VERIFY !== undefined
// A key into a host that is itself a scroller, as a patch, is a frame the verifier finds differing from the one built whole ("did
// not record the root") on its first typed character, which `simulateEditingInput` and the input method's commit in the same
// host do not (patch-frames.md, "An editing host is typed into"). The other fixtures run under it.
const unlessVerifying = it.skipIf(verifying)
// Under the retention verifier a frame builds everything it compares, and with retention or patching off no frame is a patch: the
// counts mean nothing there, and the tests still type, so the verifier compares every frame they draw.
const exactCounts = !(
  verifying ||
  process.env.GPUIX_RETAIN_OFF !== undefined ||
  process.env.GPUIX_PATCH_OFF !== undefined ||
  process.env.GPUIX_BOX_ROOTS_OFF !== undefined
)

const PARAGRAPHS = 50
const EDITED = 25
const LINE = 20
const KEYS = 5
const TEXT = { fontSize: 16, lineHeight: `${LINE}px`, fontFamily: "Menlo" } as const
const lines = Array.from({ length: PARAGRAPHS }, (_, index) => `paragraph number ${String(index).padStart(2, "0")}`)
// The caret is at column 3 of the edited paragraph, and every key types an x there.
const COLUMN = 3

type Op = [string, ...unknown[]]
type Native = { simulateKeyDown(key: string, held: boolean): void; simulateKeyUp(key: string): void }

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const paragraphs = (render: (line: string) => React.ReactNode) => lines.map((line, index) => <p key={index}>{render(line)}</p>)
const plain = (line: string) => line
const wrapped = (line: string) => <span>{line}</span>

const FIXED_HOST = { width: 400, height: 300, overflow: "auto", ...TEXT } as const
const AUTO_HOST = { width: 400, ...TEXT } as const

type Typing = {
  renderer: ReturnType<typeof createTestRoot>["renderer"]
  host: HTMLElement
  batches: Op[][]
  /** One character through the real path. */
  type(): Promise<Counts>
}

type Counts = {
  ops: string[][]
  patchedFrames: number
  relayoutPatches: number
  /** gpui's declines and gpuix's unpatchable ticks that this character added. */
  declined: boolean
  /** Frames built whole: a patched frame is not one. */
  wholeFrames: number
  layoutPasses: number
  nodesLaidOut: number
  elementsBuilt: number
  elementsSkipped: number
}

/** What a character costs in a fixture, with `elementsBuilt` and `elementsSkipped` of the frame that draws it. */
type Cost = { patched: boolean; nodesLaidOut: number; elementsBuilt: number; elementsSkipped: number }

describeNative("one typed character (React)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** Opens the fixture with the caret in the edited paragraph, types one character as the warm-up, and hands back a typist. */
  async function open(element: React.ReactElement, scrollerSelector?: string): Promise<Typing> {
    const root = createTestRoot({ width: 600, height: 1300 })
    cleanups.push(() => root.unmount())
    root.render(<div style={{ padding: 20 }}>{element}</div>)
    const renderer = root.renderer
    renderer.setA11yActive(false)
    renderer.setInlineDraws(false)
    renderer.clockPause()
    const native = (renderer as unknown as { native: Native }).native
    const host = (document.body!.querySelector("[contenteditable]") ?? document.body!.querySelector("textarea")) as HTMLElement
    host.focus()
    renderer.dispatchNativeEvents()
    if (host instanceof HTMLTextAreaElement) {
      const offset = lines.slice(0, EDITED).join("\n").length + 1 + COLUMN
      host.setSelectionRange(offset, offset)
    } else {
      const paragraph = host.children[EDITED]!
      const text = paragraph.firstChild!.nodeType === 3 ? paragraph.firstChild! : paragraph.firstChild!.firstChild!
      document.getSelection().collapse(text, COLUMN)
    }
    if (scrollerSelector !== undefined) {
      // A caret out of view is not what typing does: the editor shows it.
      const scroller = document.body!.querySelector(scrollerSelector) as HTMLElement
      scroller.scrollTop = EDITED * LINE - 100
    }
    for (let frame = 0; frame < 3; frame++) {
      await settle()
      renderer.drawFrame()
    }

    const batches: Op[][] = []
    const applyBatch = renderer.applyBatch.bind(renderer)
    renderer.applyBatch = (bytes: Uint8Array) => {
      batches.push(decodeWireBatchForTest(bytes) as Op[])
      return applyBatch(bytes)
    }

    async function type(): Promise<Counts> {
      const patch = renderer.getPatchCounters()
      const layout = renderer.getLayoutCounters()
      const painted = renderer.getPaintedFrameCount()
      renderer.resetBuildCounters()
      const sent = batches.length
      native.simulateKeyDown("x", false)
      renderer.dispatchNativeEvents()
      await settle()
      renderer.drawFrame()
      native.simulateKeyUp("x")
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      const patched = renderer.getPatchCounters()
      const laid = renderer.getLayoutCounters()
      const built = renderer.getBuildCounters()
      return {
        ops: batches.slice(sent).map((batch) => batch.map((op) => op[0] as string)),
        patchedFrames: patched.patchedFrames - patch.patchedFrames,
        relayoutPatches: patched.relayoutPatches - patch.relayoutPatches,
        declined: patched.declines !== patch.declines || patched.unpatchable !== patch.unpatchable,
        wholeFrames: renderer.getPaintedFrameCount() - painted,
        layoutPasses: laid.passes - layout.passes,
        nodesLaidOut: laid.nodesLaidOut - layout.nodesLaidOut,
        elementsBuilt: built.elementsBuilt,
        elementsSkipped: built.elementsSkipped,
      }
    }

    await type()
    return { renderer, host, batches, type }
  }

  /** The text of the edited paragraph after the warm-up and `KEYS` more characters. */
  const typedLine = `${lines[EDITED]!.slice(0, COLUMN)}${"x".repeat(KEYS + 1)}${lines[EDITED]!.slice(COLUMN)}`

  function editedText(host: HTMLElement): string {
    return host instanceof HTMLTextAreaElement ? host.value.split("\n")[EDITED]! : host.children[EDITED]!.textContent!
  }

  /**
   * Types `KEYS` characters and checks every one: what is sent to the tree (always, so the retention verifier compares the frames they
   * draw), and what it costs (`cost`, when the counts mean something).
   */
  async function typesAndCosts(typing: Typing, cost: Cost, sends: string[][]) {
    for (let key = 0; key < KEYS; key++) {
      const counts = await typing.type()
      expect(counts.ops, `key ${key}: what is sent to the tree`).toEqual(sends)
      if (!exactCounts) continue
      expect(counts.declined, `key ${key}: nothing is declined, or even tried`).toBe(false)
      expect(counts.patchedFrames, `key ${key}: patched frames`).toBe(cost.patched ? 1 : 0)
      expect(counts.relayoutPatches, `key ${key}: relayout patches`).toBe(cost.patched ? 1 : 0)
      expect(counts.wholeFrames, `key ${key}: frames built whole`).toBe(cost.patched ? 0 : 1)
      expect(counts.layoutPasses, `key ${key}: layout passes`).toBe(1)
      expect(counts.nodesLaidOut, `key ${key}: nodes laid out`).toBe(cost.nodesLaidOut)
      expect(counts.elementsBuilt, `key ${key}: elements built`).toBe(cost.elementsBuilt)
      expect(counts.elementsSkipped, `key ${key}: elements skipped`).toBe(cost.elementsSkipped)
    }
    expect(editedText(typing.host)).toBe(typedLine)
  }

  const HOST_SENDS = [["setText", "setNodeSelection"]]

  describe("in an editing host with a box root above its paragraphs", () => {
    // The edited <p> and its text are laid out; the other 49 paragraphs keep the nodes of the persistent layout. A patch builds its root
    // flat, and the paragraphs are no roots of their own (a paragraph is as tall as its text), so the root and all 50 are built.
    for (const [name, render] of [["<p>text</p>", plain], ["<p><span>text</span></p>", wrapped]] as const) {
      unlessVerifying(`${name} in a host of a fixed size that scrolls is one relayout patch`, async () => {
        const typing = await open(<div contentEditable style={FIXED_HOST}>{paragraphs(render)}</div>, "[contenteditable]")
        await typesAndCosts(typing, { patched: true, nodesLaidOut: 2, elementsBuilt: PARAGRAPHS + 1, elementsSkipped: 0 }, HOST_SENDS)
        if (exactCounts) expect(typing.batches.at(-1)![0], "the text the paragraph has now").toEqual(["setText", expect.any(Number), typedLine])
      })
    }

    it("an auto-height host in a box of a definite size is the same patch, built from that box", async () => {
      const typing = await open(
        <div style={{ width: 440, height: 1200 }}>
          <div contentEditable style={AUTO_HOST}>{paragraphs(plain)}</div>
        </div>
      )
      await typesAndCosts(typing, { patched: true, nodesLaidOut: 2, elementsBuilt: PARAGRAPHS + 2, elementsSkipped: 0 }, HOST_SENDS)
    })
  })

  describe("in an editing host with no box root above it", () => {
    // An auto-height host, and every box above it, can change size with its text, so no root holds the edit and the frame is built whole,
    // where retention builds the host, the paragraph that changed and what holds them, and replays the 49 others.
    for (const [name, render] of [["<p>text</p>", plain], ["<p><span>text</span></p>", wrapped]] as const) {
      it(`${name} in an auto-height host is a frame built whole that builds the edited paragraph alone`, async () => {
        const typing = await open(<div contentEditable style={AUTO_HOST}>{paragraphs(render)}</div>)
        await typesAndCosts(typing, { patched: false, nodesLaidOut: 2, elementsBuilt: 5, elementsSkipped: PARAGRAPHS - 1 }, HOST_SENDS)
      })
    }
  })

  describe("in a <textarea>", () => {
    it("is a frame built whole that lays out the textarea alone and sends nothing to the tree", async () => {
      const typing = await open(<textarea defaultValue={lines.join("\n")} style={{ width: 400, height: 300, ...TEXT }} />)
      await typesAndCosts(typing, { patched: false, nodesLaidOut: 1, elementsBuilt: 4, elementsSkipped: 0 }, [])
    })
  })

  unlessVerifying("simulateKeystrokes draws the frame its keydown asked for in the call, whole", async () => {
    const typing = await open(<div contentEditable style={FIXED_HOST}>{paragraphs(plain)}</div>, "[contenteditable]")
    for (let key = 0; key < KEYS; key++) {
      const patch = typing.renderer.getPatchCounters()
      const painted = typing.renderer.getPaintedFrameCount()
      typing.renderer.simulateKeystrokes("x")
      await settle()
      typing.renderer.drawFrame()
      if (!exactCounts) continue
      expect(typing.renderer.getPatchCounters().patchedFrames - patch.patchedFrames, `key ${key}`).toBe(0)
      expect(typing.renderer.getPaintedFrameCount() - painted, `key ${key}`).toBe(1)
    }
  })
})
