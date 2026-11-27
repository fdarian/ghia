/// The caret of an `<input>` and of an editing host when the window blinks it (Solid twin of the React file): on a layer of the
/// compositor, so the page paints no frame and runs no patch for a blink; a cover painted over it makes the window draw it itself.
/// The fallback, a caret the window cannot blink, is pinned by `editing-caret` through `setPaintedCarets`.
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const BLINK = 500
const PHASES = 4
const TEXT = { fontSize: 16, lineHeight: "20px", fontFamily: "Menlo" } as const
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Renderer = ReturnType<typeof createTestRoot>["renderer"]

async function settle(renderer: Renderer, frames = 12) {
  for (let frame = 0; frame < frames; frame++) {
    renderer.flush()
    renderer.dispatchNativeEvents()
    await sleep(8)
  }
}

/** A frame is drawn and shown, as a display link does, so the window decides how it shows the caret. */
function show(renderer: Renderer) {
  renderer.flush()
  renderer.drawFrame()
  renderer.presentFrame()
}

/** What the page drew while the clock moved by one change of phase: whole frames and patched ones. */
function framesInPhase(renderer: Renderer): number {
  const drawn = () => renderer.getPaintedFrameCount() + renderer.getPatchCounters().patchedFrames
  const before = drawn()
  renderer.advanceTime(BLINK)
  renderer.drawFrame()
  return drawn() - before
}

describe.skipIf(!hasNativeTestRenderer)("Solid: the caret of a window that blinks it", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  async function mountInput() {
    const root = createTestRoot({ width: 400, height: 200 })
    cleanups.push(() => root.unmount())
    const renderer = root.renderer
    renderer.clockPause()
    const [covered, setCovered] = createSignal(false)
    root.render(() => (
      <div style={{ position: "relative", width: 400, height: 200 }}>
        <input testId="probe" defaultValue="some text" style={{ width: 200, height: 24 }} />
        {covered() && <div style={{ position: "absolute", left: 0, top: 0, width: 300, height: 60, background: "#c0c0c0" }} />}
      </div>
    ))
    await settle(renderer)
    renderer.setInlineDraws(false)
    renderer.focusElement(renderer.findByTestId("probe")!.id)
    renderer.dispatchNativeEvents()
    show(renderer)
    show(renderer)
    return { renderer, cover: async (on: boolean) => {
      setCovered(on)
      await settle(renderer, 3)
      show(renderer)
      show(renderer)
    } }
  }

  it("shows a focused input's caret on the layer, asks for no frame, leaves it for a cover and goes back", async () => {
    const { renderer, cover } = await mountInput()
    expect(renderer.getCaretOnLayer()).toBe(true)
    expect(renderer.getCaretNeedsTicks()).toBe(false)
    expect(Array.from({ length: PHASES }, () => framesInPhase(renderer))).toEqual([0, 0, 0, 0])
    await cover(true)
    expect(renderer.getCaretOnLayer(), "covered").toBe(false)
    expect(Array.from({ length: PHASES }, () => framesInPhase(renderer))).toEqual([0, 0, 0, 0])
    await cover(false)
    expect(renderer.getCaretOnLayer(), "uncovered").toBe(true)
  })

  it("shows a contenteditable caret on the layer, asks for no frame, and its lit readback still alternates", async () => {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    const renderer = root.renderer
    renderer.clockPause()
    root.render(() => (
      <div style={{ padding: 20, ...TEXT }}>
        <div contentEditable style={{ width: 400, height: 300 }}>
          <div>first line</div>
        </div>
      </div>
    ))
    await settle(renderer)
    renderer.setInlineDraws(false)
    renderer.setA11yActive(false)
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    host.focus()
    renderer.dispatchNativeEvents()
    document.getSelection().collapse(host.firstChild!.firstChild!, 3)
    await sleep(0)
    show(renderer)
    show(renderer)
    expect(renderer.getCaretOnLayer()).toBe(true)
    expect(renderer.getCaretNeedsTicks()).toBe(false)
    const lit = () => renderer.getPaintedNodeSelection().caret!.lit
    expect(lit()).toBe(true)
    const seen: boolean[] = []
    const frames: number[] = []
    for (let phase = 0; phase < PHASES; phase++) {
      frames.push(framesInPhase(renderer))
      seen.push(lit())
    }
    expect(frames).toEqual([0, 0, 0, 0])
    expect(seen).toEqual([false, true, false, true])
  })
})
