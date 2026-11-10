/** Attributes are sent to native only once a sheet can apply: a `<style>` exists or a constructed sheet is adopted. */
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
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

describe.skipIf(!hasNativeTestRenderer)("attributes reach native once a sheet can apply, in React", () => {
  afterEach(() => {
    document.adoptedStyleSheets = []
  })

  it("sends no attribute while no sheet exists", () => {
    const app = createTestRoot()
    const sent = recordBatches(app.renderer)
    const view = (klass: string) => (
      <div className={klass} data-a="1">
        {Array.from({ length: 20 }, (_, index) => (
          <div key={index} className="row" data-index={index} data-open={index % 2 === 0} title="t" />
        ))}
      </div>
    )
    app.render(view("a"))
    app.render(view("b"))
    expect(sent.attributes()).toEqual([])
    app.unmount()
  })

  it("sends the attributes of mounted elements when a <style> is added, as they are by then", () => {
    const app = createTestRoot()
    const sent = recordBatches(app.renderer)
    let box: any
    let other: any
    const view = (klass: string | undefined, withStyle: boolean) => (
      <div>
        <div ref={(element: unknown) => { box = element }} className={klass} data-k="v" />
        <div ref={(element: unknown) => { other = element }} className="plain" />
        {withStyle && <style>{`.on { opacity: 0.25 } [data-k=v] { padding-top: 7px } .plain { padding-top: 3px }`}</style>}
      </div>
    )
    app.render(view(undefined, false))
    app.render(view("on", false))
    expect(sent.attributes()).toEqual([])

    app.render(view("on", true))
    expect(sent.attributes().map((op) => [op[2], op[3]])).toEqual(
      expect.arrayContaining([["class", "on"], ["data-k", "v"], ["class", "plain"]])
    )
    expect(getComputedStyle(box).opacity).toBe("0.25")
    expect(getComputedStyle(box).paddingTop).toBe("7px")
    expect(getComputedStyle(other).paddingTop).toBe("3px")

    // Opened for good: a change now is one op.
    sent.clear()
    app.render(view(undefined, true))
    expect(sent.attributes()).toEqual([["setAttribute", box.nativeId, "class", null]])
    expect(getComputedStyle(box).opacity).toBe("1")
    app.unmount()
  })

  it("sends the attributes of mounted elements when a constructed sheet is adopted", () => {
    const app = createTestRoot()
    const sent = recordBatches(app.renderer)
    let box: any
    app.render(<div ref={(element: unknown) => { box = element }} className="on" data-k="v" />)
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
    let late: any
    const view = (more: boolean) => (
      <div>
        <style>{".late { opacity: 0.5 }"}</style>
        {more && <div ref={(element: unknown) => { late = element }} className="late" data-k="v" />}
      </div>
    )
    app.render(view(false))
    expect(sent.attributes()).toEqual([])
    app.render(view(true))
    expect(sent.attributes().map((op) => [op[2], op[3]])).toEqual([["class", "late"], ["data-k", "v"]])
    expect(getComputedStyle(late).opacity).toBe("0.5")
    app.unmount()
  })
})
