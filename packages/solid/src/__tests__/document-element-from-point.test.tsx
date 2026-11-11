/** `document.elementFromPoint` and `elementsFromPoint` against the real test renderer. */
import { describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("Solid document.elementFromPoint", () => {
  it("finds an element mounted in the same turn, and lists body then html after it", () => {
    let outer!: HostElement
    let inner!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div ref={outer} style={{ width: 200, height: 200 }}>
        <div ref={inner} style={{ width: 50, height: 50 }} />
      </div>
    ))
    expect(document.elementFromPoint(10, 10)).toBe(inner)
    expect(document.elementsFromPoint(10, 10)).toEqual([inner, outer, document.body, document.documentElement])
    expect(document.elementFromPoint(100, 100)).toBe(outer)
    expect(document.elementFromPoint(300, 300)).toBe(document.body)
  })

  it("is null and empty outside the window", () => {
    const app = createTestRoot()
    app.render(() => <div style={{ width: 20, height: 20 }} />)
    expect(document.elementFromPoint(-5, 10)).toBeNull()
    expect(document.elementsFromPoint(5000, 10)).toEqual([])
  })

  it("skips pointer-events: none and visibility: hidden", () => {
    let behind!: HostElement
    let none!: HostElement
    let hidden!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 200, height: 200 }}>
        <div ref={behind} style={{ width: 100, height: 100 }} />
        <div ref={none} style={{ position: "absolute", left: 0, top: 0, width: 100, height: 100, pointerEvents: "none" }} />
        <div ref={hidden} style={{ position: "absolute", left: 0, top: 0, width: 100, height: 100, visibility: "hidden" }} />
      </div>
    ))
    const found = document.elementsFromPoint(10, 10)
    expect(found).toContain(behind)
    expect(found).not.toContain(none)
    expect(found).not.toContain(hidden)
  })
})
