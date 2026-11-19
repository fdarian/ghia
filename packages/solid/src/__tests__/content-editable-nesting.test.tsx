// An editable element is a focus target only where it is an editing host: the one with no editable parent.
import { describe, expect, it } from "vitest"
import { document } from "../index.js"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const size = { width: 80, height: 24 }

describe.skipIf(!hasNativeTestRenderer)("Solid contentEditable nesting", () => {
  it("does not make an editable element inside an editable parent a tab stop or a focus target", () => {
    let inner!: HostElement
    const app = createTestRoot({ width: 300, height: 200 })
    app.render(() => (
      <div style={{ width: 300, height: 200 }}>
        <div testId="outer" contentEditable style={size}>
          <p ref={inner} testId="inner" contentEditable style={size} />
        </div>
      </div>
    ))
    const focused = () => app.renderer.getElement(app.renderer.getFocusedElementId())?.testId ?? null
    try {
      expect(inner.isContentEditable).toBe(true)
      expect(inner.tabIndex).toBe(-1)
      inner.focus()
      expect(document.activeElement === inner).toBe(false)
      app.renderer.simulateKeystrokes("Tab")
      expect(focused()).toBe("outer")
      app.renderer.simulateKeystrokes("Tab")
      expect(focused(), "the inner element is not a second stop").not.toBe("inner")
    } finally {
      app.unmount()
    }
  })

  it("updates focusability when an editable subtree is moved into and out of a host", () => {
    let host!: HostElement
    let other!: HostElement
    const app = createTestRoot({ width: 300, height: 200 })
    app.render(() => (
      <div style={{ width: 300, height: 200 }}>
        <div ref={host} contentEditable style={size} />
        <div ref={other} style={size} />
      </div>
    ))
    const moved = document.createElement("div") as unknown as HostElement
    moved.contentEditable = "true"
    const child = document.createElement("span") as unknown as HostElement
    child.contentEditable = "true"
    moved.appendChild(child as unknown as Node)
    try {
      host.appendChild(moved as unknown as Node)
      moved.focus()
      expect(document.activeElement === moved, "inside the host").toBe(false)

      other.appendChild(moved as unknown as Node)
      moved.focus()
      expect(document.activeElement === moved, "out of it").toBe(true)
      child.focus()
      expect(document.activeElement === moved, "the child is still no target of its own").toBe(true)

      host.appendChild(moved as unknown as Node)
      ;(document.activeElement as HTMLElement).blur()
      moved.focus()
      expect(document.activeElement === moved, "back in the host").toBe(false)
    } finally {
      app.unmount()
    }
  })

  it("leaves the keys of the page alone while focus is in an editing host", () => {
    let host!: HostElement
    let button!: HostElement
    const app = createTestRoot({ width: 300, height: 200 })
    app.render(() => (
      <div testId="scroller" style={{ width: 200, height: 50, overflow: "scroll" }}>
        <div ref={host} contentEditable style={size} />
        <div ref={button} tabIndex={0} style={size} />
        <div style={{ height: 400 }} />
      </div>
    ))
    const scroller = app.renderer.findByTestId("scroller")!.id
    try {
      button.focus()
      app.renderer.scrollByKey("down", false)
      expect(app.renderer.getScrollOffset(scroller)[1], "a focusable element does not take the key").toBeGreaterThan(0)
      app.renderer.scrollTo(scroller, 0, 0)

      host.focus()
      expect(document.activeElement === host).toBe(true)
      for (const key of ["down", "pagedown", "end", "space"]) app.renderer.scrollByKey(key, false)
      expect(app.renderer.getScrollOffset(scroller)).toEqual([0, 0])
    } finally {
      app.unmount()
    }
  })
})
