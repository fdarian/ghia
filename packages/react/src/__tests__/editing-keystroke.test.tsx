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
// A patched key into a host that is itself a scroller differs under the verifier (patch-frames.md, "Typing in an editing host"); the
// fixtures that are not that patch run under it.
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
// How far below the top of the 300 px scroller the caret is: in its view, and clear of it.
const CARET_IN_VIEW_BELOW_TOP = 100
const CARET_OUT_OF_VIEW_BELOW_TOP = 500
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
  async function open(element: React.ReactElement, scroller?: "caret in view" | "caret out of view"): Promise<Typing> {
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
    // Where the caret is in the host is what the fixtures differ by; the scroll offset comes from the edited paragraph's real box, not a
    // guess at the stride (a <p> has margins, so it is not LINE).
    const scrollSoCaretIs = (below: number) => {
      const paragraph = host.children[EDITED]!.getBoundingClientRect()
      host.scrollTop += paragraph.top - host.getBoundingClientRect().top - below
    }
    // Set before the host's first frame, as a page that restores its scroll position does; scrolled after, the same offset is a frame
    // built whole (see the case that uses it).
    if (scroller === "caret out of view") scrollSoCaretIs(CARET_OUT_OF_VIEW_BELOW_TOP)
    for (let frame = 0; frame < 3; frame++) {
      await settle()
      renderer.drawFrame()
    }
    if (scroller === "caret in view") scrollSoCaretIs(CARET_IN_VIEW_BELOW_TOP)
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
    if (scroller !== undefined) {
      const caret = renderer.getPaintedNodeSelection().caret!.rect
      const view = host.getBoundingClientRect()
      const inView = caret.y >= view.top && caret.y + caret.height <= view.bottom
      expect(inView, `the caret (y ${caret.y}) is ${scroller} of the host (${view.top}..${view.bottom})`).toBe(scroller === "caret in view")
    }
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

  describe("in an editing host that is a scroller, caret in view", () => {
    // The blinking caret's paragraph is dynamic, so the scroller host is no anchor (`end_anchor` refuses on `own.dynamic`) and no patch
    // is tried: a frame built whole, where retention builds the host, the edited paragraph, its text and what holds them, and replays the
    // other 49. 2 nodes laid out are the edited paragraph and its text. The relayout patch this would otherwise be measures 1.7 to 2.1x
    // slower at this size (patch-frames.md, "Typing in an editing host").
    for (const [name, render] of [["<p>text</p>", plain], ["<p><span>text</span></p>", wrapped]] as const) {
      it(`${name} is a frame built whole that builds the edited paragraph alone`, async () => {
        const typing = await open(<div contentEditable style={FIXED_HOST}>{paragraphs(render)}</div>, "caret in view")
        await typesAndCosts(typing, { patched: false, nodesLaidOut: 2, elementsBuilt: 5, elementsSkipped: PARAGRAPHS - 1 }, HOST_SENDS)
        if (exactCounts) expect(typing.batches.at(-1)![0], "the text the paragraph has now").toEqual(["setText", expect.any(Number), typedLine])
      })
    }

    // The one fixture that patches a scroller host, and not what a user does: the scroll offset is set before the host's first frame, so
    // the caret's paragraph is culled when the frame built whole records the host, nothing in it runs, and the host is an anchor (one
    // relayout patch that builds the host flat: the host and its 50 paragraphs). The same offset applied after the first frames, which
    // is what a wheel does, is the frame built whole above (measured). Under the verifier that patch differs from the frame built whole
    // ("did not record the root") on its first typed character, which `simulateEditingInput` and the input method's commit do not
    // (patch-frames.md, "Typing in an editing host").
    unlessVerifying("a host scrolled before its first frame, caret out of view, is one relayout patch that builds the host flat", async () => {
      const typing = await open(<div contentEditable style={FIXED_HOST}>{paragraphs(plain)}</div>, "caret out of view")
      await typesAndCosts(typing, { patched: true, nodesLaidOut: 2, elementsBuilt: PARAGRAPHS + 1, elementsSkipped: 0 }, HOST_SENDS)
    })
  })

  describe("in an editing host of auto height in a box of a definite size", () => {
    it("is a relayout patch of that box", async () => {
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

  // On the only fixture that patches, to show the call draws that patch whole.
  unlessVerifying("simulateKeystrokes draws the frame its keydown asked for in the call, whole", async () => {
    const typing = await open(<div contentEditable style={FIXED_HOST}>{paragraphs(plain)}</div>, "caret out of view")
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
