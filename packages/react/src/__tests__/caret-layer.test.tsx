/// The caret of an `<input>` and of an editing host when the window blinks it: on a layer of the compositor, or drawn lit and
/// transparent by the window itself, so the page paints no frame, runs no patch and wakes nothing for a blink. A caret the window
/// cannot blink (here: inside an effect group) is the page's again, and ticks. The patch frames of that fallback are pinned by
/// `animation-frame-work` and `editing-caret`, which turn the caret into one the window cannot blink (`setPaintedCarets`).
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

// Under the retention verifier a frame builds everything it compares, and with retention or patching off no frame is a patch.
const counted = it.skipIf(
  process.env.GPUIX_RETAIN_VERIFY !== undefined || process.env.GPUIX_RETAIN_OFF !== undefined || process.env.GPUIX_PATCH_OFF !== undefined
)

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

function phases(renderer: Renderer): number[] {
  return Array.from({ length: PHASES }, () => framesInPhase(renderer))
}

describeNative("the caret of a window that blinks it", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  async function mountInput(wrap: (input: React.ReactNode) => React.ReactNode = (input) => input, cover = false) {
    const root = createTestRoot({ width: 400, height: 200 })
    cleanups.push(() => root.unmount())
    const renderer = root.renderer
    renderer.clockPause()
    const render = (covered: boolean) =>
      root.render(
        <div style={{ position: "relative", width: 400, height: 200 }}>
          {wrap(<input testId="probe" defaultValue="some text" style={{ width: 200, height: 24 }} />)}
          {covered && <div testId="cover" style={{ position: "absolute", left: 0, top: 0, width: 300, height: 60, background: "#c0c0c0" }} />}
        </div>
      )
    render(cover)
    await settle(renderer)
    renderer.setInlineDraws(false)
    renderer.focusElement(renderer.findByTestId("probe")!.id)
    renderer.dispatchNativeEvents()
    show(renderer)
    show(renderer)
    return { renderer, render }
  }

  async function mountHost(cover = false) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    const renderer = root.renderer
    renderer.clockPause()
    root.render(
      <div style={{ padding: 20, position: "relative", ...TEXT }}>
        <div contentEditable style={{ width: 400, height: 300 }}>
          <div>first line</div>
        </div>
        {cover && <div style={{ position: "absolute", left: 0, top: 0, width: 300, height: 100, background: "#c0c0c0" }} />}
      </div>
    )
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
    return { renderer }
  }

  it("shows a focused input's caret on the layer and asks for no frame over several phases", async () => {
    const { renderer } = await mountInput()
    expect(renderer.getCaretOnLayer(), "on the layer").toBe(true)
    expect(renderer.getCaretNeedsTicks(), "the page ticks nothing").toBe(false)
    expect(phases(renderer)).toEqual([0, 0, 0, 0])
    show(renderer)
    expect(renderer.getCaretOnLayer()).toBe(true)
  })

  it("shows a contenteditable caret on the layer, asks for no frame, and its lit readback still alternates", async () => {
    const { renderer } = await mountHost()
    expect(renderer.getCaretOnLayer(), "on the layer").toBe(true)
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
    expect(seen, "the clock the window blinks it by").toEqual([false, true, false, true])
  })

  it("leaves the layer for a caret something is painted over, and goes back to it when that goes", async () => {
    const { renderer, render } = await mountInput((input) => input, true)
    show(renderer)
    expect(renderer.getCaretOnLayer(), "covered").toBe(false)
    expect(renderer.getCaretNeedsTicks(), "the window blinks the quad itself").toBe(false)
    expect(phases(renderer), "the page still draws nothing").toEqual([0, 0, 0, 0])
    render(false)
    await settle(renderer, 3)
    show(renderer)
    show(renderer)
    expect(renderer.getCaretOnLayer(), "uncovered").toBe(true)
    expect(phases(renderer)).toEqual([0, 0, 0, 0])
    render(true)
    await settle(renderer, 3)
    show(renderer)
    show(renderer)
    expect(renderer.getCaretOnLayer(), "covered again").toBe(false)
  })

  it("leaves the layer for a contenteditable caret something is painted over", async () => {
    const { renderer } = await mountHost(true)
    expect(renderer.getCaretOnLayer()).toBe(false)
    expect(renderer.getCaretNeedsTicks()).toBe(false)
    expect(renderer.getPaintedNodeSelection().caret, "still painted").not.toBeNull()
    expect([framesInPhase(renderer), framesInPhase(renderer)]).toEqual([0, 0])
  })

  // An effect group composites what is in it with what is around it, which a layer cannot be, and the window cannot leave a quad
  // out of a group: the page blinks that caret, one patched frame for a change of phase.
  counted("hands the blink back to the page for a caret inside an effect group", async () => {
    const { renderer } = await mountInput((input) => <div style={{ opacity: 0.5 }}>{input}</div>)
    expect(renderer.getCaretOnLayer()).toBe(false)
    expect(renderer.getCaretNeedsTicks(), "the page has to tick").toBe(true)
    show(renderer)
    expect(framesInPhase(renderer), "the first change of phase is a frame built whole").toBeGreaterThan(0)
    const seen = phases(renderer)
    expect(seen).toEqual([1, 1, 1, 1])
  })
})
