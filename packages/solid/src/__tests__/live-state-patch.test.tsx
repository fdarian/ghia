/**
 * A pointer move that restyles an element through a state outside the subject of a selector
 * (`.card:hover + .card`) is invalidated as a batch that restyled it is: a layout patch a read prepared
 * for an earlier commit does not survive it, so a read after the move sees the new layout and the
 * frame drawn shows what a window with patching off shows. The page is the detail scroller of
 * `contained-patch.test.tsx`.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

// Under the retention verifier the reads are not answered by a patch: see contained-patch.test.tsx.
const counted = process.env.GPUIX_RETAIN_OFF === undefined && process.env.GPUIX_PATCH_OFF === undefined && process.env.GPUIX_RETAIN_VERIFY === undefined

const shots = fs.mkdtempSync(path.join(os.tmpdir(), "live-state-patch-"))

function picture(renderer: TestRenderer, name: string): string {
  const file = path.join(shots, `${process.pid}-${name}.png`)
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

function scenario(patch: boolean) {
  const [box, setBox] = createSignal(120)
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "row", width: 600, height: 400, backgroundColor: "#ffffff" }}>
      <style>{`.card { height: 40px } .card:hover + .card { height: 80px; background-color: #3b82f6 }`}</style>
      <div testId="sidebar" style={{ width: 120, flexShrink: 0, height: "100%", backgroundColor: "#f4f4f5" }}>
        <div style={{ color: "#18181b" }}>Inbox</div>
      </div>
      <div
        testId="detail"
        style={{
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
        }}
      >
        <For each={[0, 1, 2, 3, 4, 5]}>
          {(index) => (
            <div testId={`card-${index}`} class="card" style={{ width: box(), flexShrink: 0, backgroundColor: "#fee2e2" }} />
          )}
        </For>
        <div style={{ width: 8, height: 400, flexShrink: 0 }} />
      </div>
    </div>
  ))
  const renderer = app.renderer
  try {
    renderer.setA11yActive(false)
    renderer.setInlineDraws(false)
    renderer.setPatchEnabled(patch)
    renderer.drawFrame()
    renderer.drawFrame()
    const next = renderer.findByTestId("card-1")!.id
    const card = renderer.findByTestId("card-0")!.id
    // A commit that moves boxes inside the scroller, and a read that prepares its patch.
    const passes = [renderer.getLayoutPassCount()]
    app.root.flushSync(() => setBox(200))
    const read = renderer.getElementBounds(card)
    passes.push(renderer.getLayoutPassCount())
    const at = renderer.getElementBounds(card)!
    // The pointer enters the card with that patch prepared: no draw comes between.
    renderer.dispatchMouseMove(at.x + 100, at.y + 30)
    const afterMove = renderer.getElementBounds(next)
    passes.push(renderer.getLayoutPassCount())
    renderer.drawFrame()
    const afterDraw = renderer.getElementBounds(next)
    return { passes, read, afterMove, afterDraw, picture: picture(renderer, `hover-${patch}`), mismatches: renderer.getRetainedCounters().mismatches }
  } finally {
    app.unmount()
  }
}

describe.skipIf(!hasNativeTestRenderer)("Solid: a live state restyle after a commit with a prepared patch", () => {
  it("is seen by the next read, and drawn as patching off draws it", () => {
    const on = scenario(true)
    const off = scenario(false)
    expect(off.afterMove?.height).toBe(80)
    expect(on.afterMove?.height, "the read after the move sees the new layout").toBe(80)
    expect(on.afterDraw).toEqual(off.afterDraw)
    expect(on.picture).toEqual(off.picture)
    expect(on.mismatches).toBe(0)
    if (!counted) return
    // The read after the commit was answered by a prepared patch (no layout pass), which the move has to throw away: the height it
    // reads after the move holds the commit and the hover, which that patch did not.
    expect(on.passes[1] - on.passes[0], "the commit's read is a prepared patch").toBe(0)
  }, 60_000)
})
