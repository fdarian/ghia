/**
 * A drawn frame covers every batch applied before it. The test renderer records that a batch is
 * owed a notify (`UNFLUSHED_MUTATIONS`) and a read pays it; a frame that is drawn has to pay it
 * as well, or the next `flushIfDirty` (the one every `simulate*` helper starts with) notifies the
 * view again and the page is redrawn unchanged.
 */

import { describe, expect, it } from "vitest"
import type { EventPayload } from "../../index.js"
import { TestRenderer, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const BOX = 2

type Native = { flushIfDirty(): void; simulateKeyDown(keystroke: string): void }

/** The renderer's native half, which the `simulate*` wrappers add flushes and focus changes to. */
function nativeOf(renderer: TestRenderer): Native {
  return (renderer as unknown as { native: Native }).native
}

function setHeight(height: number): string {
  return JSON.stringify([["setStyle", BOX, { height, width: 50 }]])
}

function mount(options: { dispatchSyncEvent?: (event: EventPayload) => { defaultPrevented: boolean; propagationStopped: boolean } } = {}) {
  const renderer = new TestRenderer({ width: 200, height: 200, ...options })
  renderer.clockPause()
  renderer.applyBatch(
    JSON.stringify([
      ["createElement", 1, "div"],
      ["setRoot", 1],
      ["setStyle", 1, { display: "flex", flexDirection: "column", width: 100 }],
      ["createElement", BOX, "div"],
      ["appendChild", 1, BOX],
      ["setStyle", BOX, { height: 20, width: 50 }],
    ])
  )
  renderer.flush()
  renderer.setInlineDraws(false)
  renderer.drawFrame()
  return renderer
}

describeNative("a drawn frame and the notify a batch is owed", () => {
  it("is covered by a frame that draws after a read and another batch", () => {
    const renderer = mount()
    try {
      renderer.applyBatch(setHeight(30))
      expect(renderer.getElementBounds(BOX)!.height).toBe(30)
      renderer.applyBatch(setHeight(50))

      const painted = renderer.getPaintedFrameCount()
      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount()).toBe(painted + 1)
      expect(renderer.getElementBounds(BOX)!.height).toBe(50)

      nativeOf(renderer).flushIfDirty()
      expect(renderer.getPaintedFrameCount()).toBe(painted + 1)
    } finally {
      renderer.dispose()
    }
  })

  it("is covered by the frame that follows a key handler that read layout and applied another batch", () => {
    let handled = 0
    let renderer: TestRenderer | undefined
    renderer = mount({
      dispatchSyncEvent: () => {
        if (handled++ === 0) {
          renderer!.applyBatch(setHeight(30))
          renderer!.getElementBounds(BOX)
          renderer!.applyBatch(setHeight(50))
        }
        return { defaultPrevented: false, propagationStopped: false }
      },
    })
    try {
      renderer.setWindowKeyEvents(true, false, 1)
      const native = nativeOf(renderer)
      native.flushIfDirty()
      native.simulateKeyDown("a")
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      expect(renderer.getElementBounds(BOX)!.height).toBe(50)

      const painted = renderer.getPaintedFrameCount()
      native.flushIfDirty()
      native.simulateKeyDown("b")
      renderer.dispatchNativeEvents()
      renderer.drawFrame()
      expect(renderer.getPaintedFrameCount()).toBe(painted)
    } finally {
      renderer.dispose()
    }
  })
})
