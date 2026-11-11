/// Whether an element is an inline box is up to its effective `display`, never its tag, and Chrome's own rules
/// hold: an `<a>` with `display: block` takes a transform and a motion value in `style.x`, a `<div>` with
/// `display: inline` does not.
// @ts-nocheck

import React from "react"
import { describe, expect, it } from "vitest"
import { motionValue } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const BOX = { width: 100, height: 50, backgroundColor: "#336699" }
const MOVED = { initial: { y: 8 }, animate: { y: 8 }, transition: { duration: 0 } }

function boundsOf(tree: React.ReactNode, testId = "box") {
  const { render, renderer, unmount } = createTestRoot({ width: 800, height: 600 })
  try {
    renderer.clockPause()
    render(<div style={{ padding: 100 }}>{tree}</div>)
    renderer.flush()
    return renderer.getElementBounds(renderer.findByTestId(testId).id)
  } finally {
    unmount()
  }
}

describeNative("motion and display", () => {
  it("a block <a> takes a transform, as Chrome applies one to a block box", () => {
    const at = boundsOf(<a testId="box" style={{ ...BOX, display: "block" }} />)
    const moved = boundsOf(<a testId="box" style={{ ...BOX, display: "block" }} motion={MOVED} />)
    expect(moved.y - at.y).toBeCloseTo(8, 2)
    expect(moved.x).toBeCloseTo(at.x, 2)
  })

  it("a block <span> takes a transform too, one rule for the tag a span is and the tags an inline tag is", () => {
    const at = boundsOf(<span testId="box" style={{ ...BOX, display: "block" }} />)
    const moved = boundsOf(<span testId="box" style={{ ...BOX, display: "block" }} motion={MOVED} />)
    expect(moved.y - at.y).toBeCloseTo(8, 2)
  })

  it("a motion value in style.x moves a block <a> and a block <span>", () => {
    for (const Tag of ["a", "span"]) {
      const at = boundsOf(<Tag testId="box" style={{ ...BOX, display: "block" }} />)
      const moved = boundsOf(<Tag testId="box" style={{ ...BOX, display: "block", x: motionValue(12) }} />)
      expect(moved.x - at.x, Tag).toBeCloseTo(12, 2)
    }
  })

  /** The errors of rendering `element`, which React reports to `onUncaughtError` and not out of `render`. */
  function errorsOf(element: React.ReactNode): Error[] {
    const errors: Error[] = []
    const { render, unmount } = createTestRoot({ width: 800, height: 600, onUncaughtError: (error) => errors.push(error) })
    try {
      render(element)
    } catch (error) {
      errors.push(error)
    }
    unmount()
    return errors
  }

  it("a motion value in style.x still throws on an inline <a>, an inline <span> and a <div> that says display inline", () => {
    for (const [Tag, display] of [["a", undefined], ["span", undefined], ["a", "inline"], ["div", "inline"]] as const) {
      const errors = errorsOf(<Tag style={{ display, x: motionValue(12) }}>text</Tag>)
      expect(errors.map((error) => error.message.split(":")[0]), `${Tag} ${display}`).toEqual([`A ${Tag} cannot take a motion value in style.x`])
    }
  })

  it("a motion value in style.x does not throw on a <div> with no display or on a <button>", () => {
    expect(errorsOf(<div style={{ x: motionValue(12) }}>text</div>)).toEqual([])
    expect(errorsOf(<button style={{ display: "inline", x: motionValue(12) }}>text</button>)).toEqual([])
  })
})
