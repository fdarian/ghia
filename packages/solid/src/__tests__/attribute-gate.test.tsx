/** Attributes are sent to native only once a sheet can apply: a `<style>` exists or a constructed sheet is adopted. */
import { afterEach, describe, expect, it } from "vitest"
import { Show, createSignal } from "solid-js"
import { CSSStyleSheet, document, getComputedStyle } from "@ghia/native/host"
import { decodeWireBatchForTest } from "@ghia/native/testing"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

type Op = [string, ...unknown[]]

function recordBatches(renderer: { applyBatch(bytes: Uint8Array): unknown }) {
  const ops: Op[] = []
  const original = renderer.applyBatch.bind(renderer)
  renderer.applyBatch = (bytes: Uint8Array) => {
    ops.push(...(decodeWireBatchForTest(bytes) as Op[]))
    return original(bytes)
  }
  return {
    attributes: () => ops.filter((op) => op[0] === "setAttribute"),
    clear: () => ops.splice(0),
  }
}

describe.skipIf(!hasNativeTestRenderer)("attributes reach native once a sheet can apply, in Solid", () => {
  afterEach(() => {
    document.adoptedStyleSheets = []
  })

  it("sends no attribute while no sheet exists", () => {
    const app = createTestRoot()
    const sent = recordBatches(app.renderer)
    const [klass, setKlass] = createSignal("a")
    app.render(() => (
      <div class={klass()} data-a="1">
        {Array.from({ length: 20 }, (_, index) => (
          <div class="row" data-index={index} data-open={index % 2 === 0} title="t" />
        ))}
      </div>
    ))
    app.flushSync(() => setKlass("b"))
    expect(sent.attributes()).toEqual([])
    app.unmount()
  })

  it("sends the attributes of mounted elements when a <style> is added, as they are by then", () => {
    const app = createTestRoot()
    const sent = recordBatches(app.renderer)
    const [klass, setKlass] = createSignal<string | undefined>(undefined)
    const [withStyle, setWithStyle] = createSignal(false)
    let box: any
    let other: any
    app.render(() => (
      <div>
        <div ref={(element: unknown) => (box = element)} class={klass()} data-k="v" />
        <div ref={(element: unknown) => (other = element)} class="plain" />
        <Show when={withStyle()}>
          <style>{`.on { opacity: 0.25 } [data-k=v] { padding-top: 7px } .plain { padding-top: 3px }`}</style>
        </Show>
      </div>
    ))
    app.flushSync(() => setKlass("on"))
    expect(sent.attributes()).toEqual([])

    app.flushSync(() => setWithStyle(true))
    expect(sent.attributes().map((op) => [op[2], op[3]])).toEqual(
      expect.arrayContaining([["class", "on"], ["data-k", "v"], ["class", "plain"]])
    )
    expect(getComputedStyle(box).opacity).toBe("0.25")
    expect(getComputedStyle(box).paddingTop).toBe("7px")
    expect(getComputedStyle(other).paddingTop).toBe("3px")

    // Opened for good: a change now is one op.
    sent.clear()
    app.flushSync(() => setKlass(undefined))
    expect(sent.attributes()).toEqual([["setAttribute", box.nativeId, "class", null]])
    expect(getComputedStyle(box).opacity).toBe("1")
    app.unmount()
  })

  it("sends the attributes of mounted elements when a constructed sheet is adopted", () => {
    const app = createTestRoot()
    const sent = recordBatches(app.renderer)
    let box: any
    app.render(() => <div ref={(element: unknown) => (box = element)} class="on" data-k="v" />)
    expect(sent.attributes()).toEqual([])

    const sheet = new CSSStyleSheet()
    sheet.replaceSync(".on[data-k=v] { opacity: 0.25 }")
    document.adoptedStyleSheets = [sheet]
    // The sheet ops wait in the queue until something flushes it: a read does.
    expect(getComputedStyle(box).opacity).toBe("0.25")
    expect(sent.attributes().map((op) => [op[1], op[2], op[3]])).toEqual([
      [box.nativeId, "class", "on"],
      [box.nativeId, "data-k", "v"],
    ])
    app.unmount()
  })

  it("sends the attributes of an element created after a <style>", () => {
    const app = createTestRoot()
    const sent = recordBatches(app.renderer)
    const [more, setMore] = createSignal(false)
    let late: any
    app.render(() => (
      <div>
        <style>{".late { opacity: 0.5 }"}</style>
        <Show when={more()}>
          <div ref={(element: unknown) => (late = element)} class="late" data-k="v" />
        </Show>
      </div>
    ))
    expect(sent.attributes()).toEqual([])
    app.flushSync(() => setMore(true))
    expect(sent.attributes().map((op) => [op[2], op[3]])).toEqual([["class", "late"], ["data-k", "v"]])
    expect(getComputedStyle(late).opacity).toBe("0.5")
    app.unmount()
  })
})
