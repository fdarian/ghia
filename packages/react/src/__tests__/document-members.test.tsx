// document.getElementById and createElement next to mounted elements, and window.scrollX.
import { describe, expect, it } from "vitest"
import type { PublicInstance } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative("document.getElementById", () => {
  it("finds the first mounted element with that id, in document order", () => {
    let first: PublicInstance | null = null
    let second: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div>
        <div ref={(element) => { first = element }} id="target" />
        <div ref={(element) => { second = element }} id="target" />
        <div id="other" />
      </div>
    )
    try {
      expect(document.getElementById("target")).toBe(first)
      expect(document.getElementById("other")).not.toBe(second)
      expect(document.getElementById("missing")).toBeNull()
      expect(document.getElementById("")).toBeNull()
    } finally {
      root.unmount()
    }
  })

  it("matches an id that is not a valid selector", () => {
    let box: PublicInstance | null = null
    const root = createTestRoot()
    root.render(<div ref={(element) => { box = element }} id=":r1:.a b" />)
    try {
      expect(document.getElementById(":r1:.a b")).toBe(box)
    } finally {
      root.unmount()
    }
  })

  it("follows the id as a framework commits it, and never finds a detached element", () => {
    const root = createTestRoot()
    let box: PublicInstance | null = null
    const view = (id: string) => <div ref={(element) => { box = element }} id={id} />
    try {
      root.render(view("a"))
      expect(document.getElementById("a")).toBe(box)
      root.render(view("b"))
      expect(document.getElementById("a")).toBeNull()
      expect(document.getElementById("b")).toBe(box)
      const detached = document.createElement("div")
      detached.setAttribute("id", "made")
      expect(document.getElementById("made")).toBeNull()
    } finally {
      root.unmount()
    }
  })
})

describeNative("createElement beside a mounted tree", () => {
  it("makes an element that measures as nothing and is not a mounted one", () => {
    const root = createTestRoot()
    root.render(<div style={{ width: 50, height: 50 }} />)
    try {
      const made = document.createElement("div")
      expect(made.isConnected).toBe(false)
      expect(made.offsetWidth).toBe(0)
      expect(made.getRootNode()).toBe(made)
      expect(window.scrollX).toBe(0)
      expect(window.scrollY).toBe(0)
    } finally {
      root.unmount()
    }
  })
})
