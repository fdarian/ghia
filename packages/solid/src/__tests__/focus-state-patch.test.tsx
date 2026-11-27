/**
 * A commit that moves focus (an element made with `autoFocus`, a focused control that becomes `disabled`) and is drawn as
 * a layout patch: the sheets' `:focus` and `:disabled` rules read the focus the commit left, so the frame shows what a
 * window with patching off shows. The page is the detail scroller of `live-state-patch.test.tsx`. A focus that moves is a
 * source of the tick (`Retain::preview` answers `Sourced`), so such a frame is built whole, where `sync_live_states` runs
 * after `sync_focus_handles`; this pins that a patch never draws the sheets' focus states a frame late.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { For, Show, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import type { TestRenderer } from "../testing.js"

const shots = fs.mkdtempSync(path.join(os.tmpdir(), "focus-state-patch-"))

function picture(renderer: TestRenderer, name: string): string {
  const file = path.join(shots, `${process.pid}-${name}.png`)
  renderer.captureShownFrame(file)
  const bytes = fs.readFileSync(file)
  fs.rmSync(file, { force: true })
  return bytes.toString("base64")
}

type Kind = "autofocus" | "disabled"

function scenario(kind: Kind, patch: boolean) {
  const [width, setWidth] = createSignal(120)
  const [fresh, setFresh] = createSignal(false)
  const [disabled, setDisabled] = createSignal(false)
  const app = createTestRoot({ width: 600, height: 400 })
  app.render(() => (
    <div style={{ display: "flex", flexDirection: "row", width: 600, height: 400, backgroundColor: "#ffffff" }}>
      <style>{`.card { height: 40px } .card:focus { height: 80px; background-color: #3b82f6 } button.card:disabled { height: 60px; background-color: #a1a1aa }`}</style>
      <div testId="sidebar" style={{ width: 120, flexShrink: 0, height: "100%", backgroundColor: "#f4f4f5" }} />
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
        <For each={[0, 1, 2, 3]}>
          {(index) => <div testId={`card-${index}`} class="card" tabIndex={0} style={{ width: width(), flexShrink: 0, backgroundColor: "#fee2e2" }} />}
        </For>
        <button testId="button" class="card" disabled={disabled()} style={{ width: width(), flexShrink: 0 }}>
          Go
        </button>
        <Show when={fresh()}>
          <div testId="fresh" class="card" tabIndex={0} autoFocus style={{ width: width(), flexShrink: 0, backgroundColor: "#fee2e2" }} />
        </Show>
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
    const button = renderer.findByTestId("button")!.id
    if (kind === "disabled") {
      renderer.focusElement(button)
      renderer.drawFrame()
    }
    // A commit that moves boxes inside the scroller, and one change of the focus.
    app.root.flushSync(() => {
      setWidth(200)
      if (kind === "autofocus") setFresh(true)
      else setDisabled(true)
    })
    // A read that prepares the commit's patch, then the frame.
    renderer.getElementBounds(renderer.findByTestId("card-0")!.id)
    renderer.drawFrame()
    const bounds = (testId: string) => renderer.getElementBounds(renderer.findByTestId(testId)!.id)
    const focused = renderer.getFocusedElementId()
    return {
      fresh: kind === "autofocus" ? bounds("fresh") : undefined,
      button: bounds("button"),
      focusedTestId: focused === null || focused === undefined ? null : renderer.getElement(focused)?.testId ?? null,
      picture: picture(renderer, `${kind}-${patch}`),
      mismatches: renderer.getRetainedCounters().mismatches,
    }
  } finally {
    app.unmount()
  }
}

describe.skipIf(!hasNativeTestRenderer)("Solid: a focus change in a commit drawn as a layout patch", () => {
  it("restyles an element made with autoFocus by :focus, as patching off draws it", () => {
    const on = scenario("autofocus", true)
    const off = scenario("autofocus", false)
    expect(off.focusedTestId).toBe("fresh")
    expect(off.fresh?.height).toBe(80)
    expect(on.focusedTestId).toBe("fresh")
    expect(on.fresh).toEqual(off.fresh)
    expect(on.picture).toEqual(off.picture)
    expect(on.mismatches).toBe(0)
  }, 60_000)

  it("restyles a focused control that becomes disabled, and drops its focus, as patching off draws it", () => {
    const on = scenario("disabled", true)
    const off = scenario("disabled", false)
    expect(off.focusedTestId).not.toBe("button")
    expect(off.button?.height).toBe(60)
    expect(on.focusedTestId).toBe(off.focusedTestId)
    expect(on.button).toEqual(off.button)
    expect(on.picture).toEqual(off.picture)
    expect(on.mismatches).toBe(0)
  }, 60_000)
})
