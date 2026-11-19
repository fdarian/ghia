// An editable element is a focus target only where it is an editing host: the one with no editable parent.
import { describe, expect, it } from "vitest"
import type { PublicInstance } from "@ghia/native/host"
import { document } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const size = { width: 80, height: 24 }

describeNative("contentEditable nesting", () => {
  it("does not make an editable element inside an editable parent a tab stop or a focus target", () => {
    let outer: PublicInstance | null = null
    let inner: PublicInstance | null = null
    const root = createTestRoot({ width: 300, height: 200 })
    // React sends an element's props before it appends it, so the inner one is a host while it has no parent.
    root.render(
      <div style={{ width: 300, height: 200 }}>
        <div ref={(element) => { outer = element }} contentEditable style={size}>
          <p ref={(element) => { inner = element }} contentEditable style={size} />
        </div>
      </div>
    )
    try {
      expect(inner!.isContentEditable).toBe(true)
      expect(inner!.tabIndex).toBe(-1)
      inner!.focus()
      expect(document.activeElement === inner).toBe(false)
      root.renderer.simulateKeystrokes("Tab")
      expect(root.renderer.getFocusedElementId()).toBe(outer!.nativeId)
      root.renderer.simulateKeystrokes("Tab")
      expect(root.renderer.getFocusedElementId(), "the inner element is not a second stop").not.toBe(inner!.nativeId)
    } finally {
      root.unmount()
    }
  })

  it("updates focusability when an editable subtree is moved into and out of a host", () => {
    let host: PublicInstance | null = null
    let other: PublicInstance | null = null
    const root = createTestRoot({ width: 300, height: 200 })
    root.render(
      <div style={{ width: 300, height: 200 }}>
        <div ref={(element) => { host = element }} contentEditable style={size} />
        <div ref={(element) => { other = element }} style={size} />
      </div>
    )
    const moved = document.createElement("div") as unknown as PublicInstance
    moved.contentEditable = "true"
    const child = document.createElement("span") as unknown as PublicInstance
    child.contentEditable = "true"
    moved.appendChild(child as unknown as Node)
    try {
      host!.appendChild(moved as unknown as Node)
      moved.focus()
      expect(document.activeElement === moved, "inside the host").toBe(false)

      other!.appendChild(moved as unknown as Node)
      moved.focus()
      expect(document.activeElement === moved, "out of it").toBe(true)
      child.focus()
      expect(document.activeElement === moved, "the child is still no target of its own").toBe(true)

      host!.appendChild(moved as unknown as Node)
      ;(document.activeElement as HTMLElement).blur()
      moved.focus()
      expect(document.activeElement === moved, "back in the host").toBe(false)
    } finally {
      root.unmount()
    }
  })

  it("leaves the editing keys alone while focus is in an editing host and still scrolls for Home, End and Page Up and Down, as Chrome does", () => {
    let host: PublicInstance | null = null
    let button: PublicInstance | null = null
    const root = createTestRoot({ width: 300, height: 200 })
    root.render(
      <div testId="scroller" style={{ width: 200, height: 50, overflow: "scroll" }}>
        <div ref={(element) => { host = element }} contentEditable style={size} />
        <div ref={(element) => { button = element }} tabIndex={0} style={size} />
        <div style={{ height: 400 }} />
      </div>
    )
    const scroller = root.renderer.findByTestId("scroller").id
    try {
      button!.focus()
      root.renderer.scrollByKey("down", false)
      expect(root.renderer.getScrollOffset(scroller)[1], "a focusable element does not take the key").toBeGreaterThan(0)
      root.renderer.scrollTo(scroller, 0, 0)

      host!.focus()
      expect(document.activeElement === host).toBe(true)
      for (const key of ["up", "down", "left", "right", "space"]) root.renderer.scrollByKey(key, false)
      root.renderer.scrollByKey("space", true)
      root.renderer.scrollByKey("pagedown", true)
      root.renderer.scrollByKey("pageup", true)
      expect(root.renderer.getScrollOffset(scroller), "arrows, Space and Shift+Page keys are editing keys").toEqual([0, 0])

      root.renderer.scrollByKey("pagedown", false)
      const paged = root.renderer.getScrollOffset(scroller)[1]
      expect(paged, "Page Down scrolls the nearest scroller").toBeGreaterThan(0)
      root.renderer.scrollByKey("end", false)
      const end = root.renderer.getScrollOffset(scroller)[1]
      expect(end, "End scrolls to the end").toBeGreaterThan(paged)
      root.renderer.scrollByKey("pageup", false)
      expect(root.renderer.getScrollOffset(scroller)[1], "Page Up scrolls back").toBeLessThan(end)
      root.renderer.scrollByKey("home", false)
      expect(root.renderer.getScrollOffset(scroller), "Home scrolls to the start").toEqual([0, 0])
      expect(document.activeElement === host, "the focus stays").toBe(true)
    } finally {
      root.unmount()
    }
  })
})
