/// A <nativeview> inside an effect group (an ancestor with an opacity that is not 1, held or
/// animating, a filter, a mask, a clip path): the group is split at the native view, so the view
/// takes the opacity of every group around it and its children are above it, as in a browser where
/// the opacity of an ancestor applies to the whole subtree. The test renderer records the layers of
/// the composed frame instead of showing AppKit views: `getCompositionLayers` says which side of the
/// native layer each primitive and group is on.

import React from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { defineKeyframes } from "../index"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

defineKeyframes("nativeview-group-fade", { from: { opacity: 0.2 }, to: { opacity: 0.8 } })

describeNative("custom element: nativeview in an effect group", () => {
  let testRoot: TestRoot

  beforeEach(() => {
    testRoot = createTestRoot({ width: 400, height: 300 })
  })

  afterEach(() => {
    testRoot.unmount()
  })

  const renderer = () => testRoot.renderer
  const surface = (testId = "n") => renderer().getNativeviewSurface(renderer().findByTestId(testId).id)!

  /** The primitives and groups drawn below the native layer and above it. */
  const sides = () => {
    const layers = renderer().getCompositionLayers()
    const native = layers.findIndex((layer) => layer.kind === "native")
    expect(native, "the native view is in the frame").toBeGreaterThan(-1)
    const count = (side: typeof layers) => side.reduce((sum, layer) => sum + (layer.kind === "gpui" ? layer.primitives : 0), 0)
    return { below: count(layers.slice(0, native)), above: count(layers.slice(native + 1)) }
  }

  const glass = (children?: React.ReactNode) => (
    <nativeview testId="n" style={{ width: 200, height: 120, backgroundColor: "#335577" }}>
      {children}
    </nativeview>
  )
  const label = <div style={{ color: "#ffffff", width: 100, height: 20 }}>Glass label</div>

  it("puts the children of a view under a held opacity above it, and fades the view", () => {
    testRoot.render(<div style={{ opacity: 0.5 }}>{glass(label)}</div>)

    expect(surface().opacity).toBeCloseTo(0.5, 2)
    const { below, above } = sides()
    expect(below, "the box").toBeGreaterThan(0)
    expect(above, "the children").toBeGreaterThan(0)
  })

  it("puts the children above it for an opacity that animates, and follows it", () => {
    renderer().clockPause()
    testRoot.render(
      <div style={{ animation: "nativeview-group-fade 1s linear infinite" }}>{glass(label)}</div>,
    )
    renderer().clockFastForward(500)

    expect(surface().opacity).toBeCloseTo(0.5, 1)
    expect(sides().above).toBeGreaterThan(0)
    renderer().clockFastForward(250)
    expect(surface().opacity).toBeCloseTo(0.65, 1)
  })

  it("multiplies the opacity of nested groups", () => {
    testRoot.render(
      <div style={{ opacity: 0.5 }}>
        <div style={{ opacity: 0.5 }}>{glass(label)}</div>
      </div>,
    )

    expect(surface().opacity).toBeCloseTo(0.25, 2)
    expect(sides().above).toBeGreaterThan(0)
  })

  it("multiplies the view's own opacity with the groups around it", () => {
    testRoot.render(
      <div style={{ opacity: 0.5 }}>
        <nativeview testId="n" style={{ width: 200, height: 120, opacity: 0.5 }}>
          {label}
        </nativeview>
      </div>,
    )

    expect(surface().opacity).toBeCloseTo(0.25, 2)
    expect(sides().above).toBeGreaterThan(0)
  })

  it("fades the view with the opacity of a filter group, whose filter does not reach it", () => {
    testRoot.render(<div style={{ opacity: 0.6, filter: "blur(2px)" }}>{glass(label)}</div>)

    expect(surface().opacity).toBeCloseTo(0.6, 2)
    expect(sides().above).toBeGreaterThan(0)

    testRoot.render(<div style={{ filter: "blur(2px)" }}>{glass(label)}</div>)
    expect(surface().opacity).toBe(1)
    expect(sides().above).toBeGreaterThan(0)
  })

  it("splits a group of a clip path and of a mask too", () => {
    testRoot.render(<div style={{ clipPath: "inset(10px)" }}>{glass(label)}</div>)
    expect(surface().opacity).toBe(1)
    expect(sides().above).toBeGreaterThan(0)

    testRoot.render(<div style={{ maskImage: "linear-gradient(black, transparent)" }}>{glass(label)}</div>)
    expect(surface().opacity).toBe(1)
    expect(sides().above).toBeGreaterThan(0)
  })

  it("drops a view in a group that is faded out", () => {
    testRoot.render(<div style={{ opacity: 0 }}>{glass(label)}</div>)

    expect(renderer().getNativeviewSurface(renderer().findByTestId("n").id)).toBeNull()
  })

  it("keeps the content before and after the view on the sides of it they overlap", () => {
    testRoot.render(
      <div style={{ opacity: 0.5, position: "relative", width: 400, height: 300 }}>
        <div testId="before" style={{ position: "absolute", left: 0, top: 0, width: 150, height: 150, backgroundColor: "#cc3333" }} />
        <div style={{ position: "absolute", left: 100, top: 100 }}>{glass()}</div>
        <div testId="after" style={{ position: "absolute", left: 250, top: 150, width: 100, height: 100, backgroundColor: "#33cc33" }} />
        <div testId="over" style={{ position: "absolute", left: 120, top: 120, width: 60, height: 60, backgroundColor: "#3333cc" }} />
      </div>,
    )

    const { below, above } = sides()
    expect(surface().opacity).toBeCloseTo(0.5, 2)
    expect(below, "what was painted before the view and overlaps it").toBeGreaterThan(0)
    expect(above, "what was painted after the view and overlaps it").toBeGreaterThan(0)
  })

  it("leaves a group without a view as it was: one group, in one layer", () => {
    testRoot.render(
      <div style={{ position: "relative", width: 400, height: 300 }}>
        <div style={{ opacity: 0.5 }}>
          <div style={{ width: 100, height: 100, backgroundColor: "#cc3333" }} />
          <div style={{ width: 100, height: 100, marginTop: -50, backgroundColor: "#33cc33" }} />
        </div>
        <div style={{ position: "absolute", left: 250, top: 150 }}>{glass()}</div>
      </div>,
    )

    const total = renderer()
      .getCompositionLayers()
      .reduce((sum, layer) => sum + (layer.kind === "gpui" ? layer.primitives : 0), 0)
    expect(total, "the group and the box of the view").toBe(2)
    expect(surface().opacity).toBe(1)
  })
})
