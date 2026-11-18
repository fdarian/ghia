// contentEditable: the reflected property, isContentEditable, and an editing host as a focus target and as :read-write.
import { createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { document } from "../index.js"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const size = { width: 80, height: 24 }

describe.skipIf(!hasNativeTestRenderer)("Solid contentEditable", () => {
  it("makes an editing host that focus() reaches, and leaves what is inside it to the host", () => {
    let host!: HostElement
    let inside!: HostElement
    let island!: HostElement
    let nested!: HostElement
    let plain!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 300, height: 200 }}>
        <div ref={host} contentEditable style={size}>
          <span ref={inside}>text</span>
          <div ref={island} contentEditable={false} style={size}>
            <div ref={nested} contenteditable="plaintext-only" style={size} />
          </div>
        </div>
        <div ref={plain} style={size} />
      </div>
    ))
    try {
      expect(host.contentEditable).toBe("true")
      expect(host.getAttribute("contenteditable")).toBe("true")
      expect(host.isContentEditable).toBe(true)
      expect(inside.isContentEditable).toBe(true)
      expect(island.contentEditable).toBe("false")
      expect(island.isContentEditable).toBe(false)
      expect(nested.contentEditable).toBe("plaintext-only")
      expect(nested.isContentEditable).toBe(true)
      expect(plain.contentEditable).toBe("inherit")

      expect(host.tabIndex).toBe(0)
      expect(inside.tabIndex).toBe(-1)

      host.focus()
      expect(document.activeElement === host).toBe(true)
      inside.focus()
      expect(document.activeElement === host, "text inside a host is not a focus target of its own").toBe(true)
      plain.focus()
      expect(document.activeElement === host).toBe(true)
      nested.focus()
      expect(document.activeElement === nested, "an editable element under a false island is a host").toBe(true)
    } finally {
      app.unmount()
    }
  })

  it("follows the signal and the property, and :read-write follows with it", () => {
    let box!: HostElement
    let child!: HostElement
    const [editable, setEditable] = createSignal<boolean | undefined>(undefined)
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 300, height: 200 }}>
        <div ref={box} contentEditable={editable()} style={size}>
          <span ref={child} />
        </div>
      </div>
    ))
    try {
      expect(box.matches(":read-only")).toBe(true)
      box.focus()
      expect(document.activeElement === box).toBe(false)

      setEditable(true)
      expect(box.matches(":read-write") && child.matches(":read-write")).toBe(true)
      box.focus()
      expect(document.activeElement === box).toBe(true)

      setEditable(false)
      expect(box.getAttribute("contenteditable")).toBe("false")
      expect(box.matches(":read-only") && child.matches(":read-only")).toBe(true)

      box.contentEditable = "TRUE"
      expect(box.getAttribute("contenteditable")).toBe("true")
      expect(child.isContentEditable).toBe(true)
      box.contentEditable = "inherit"
      expect(box.hasAttribute("contenteditable")).toBe(false)
    } finally {
      app.unmount()
    }
  })

  it("throws a SyntaxError for text that is not a keyword", () => {
    let box!: HostElement
    const app = createTestRoot()
    app.render(() => <div ref={box} contentEditable style={size} />)
    try {
      expect(() => {
        box.contentEditable = "yes"
      }).toThrowError(expect.objectContaining({ name: "SyntaxError" }))
      expect(box.contentEditable).toBe("true")
    } finally {
      app.unmount()
    }
  })

  it("takes focus when code sets the selection inside it, as Chrome does, and leaves a selection that stays in it alone", () => {
    let one!: HostElement
    let two!: HostElement
    let other!: HostElement
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 300, height: 200 }}>
        <div ref={one} contentEditable style={size}>first</div>
        <div ref={two} contentEditable style={size}>second</div>
        <button ref={other} style={size}>other</button>
      </div>
    ))
    try {
      const selection = document.getSelection()
      selection.collapse(one.firstChild, 2)
      expect(document.activeElement === one).toBe(true)
      selection.collapse(two.firstChild, 3)
      expect(document.activeElement === two).toBe(true)
      other.focus()
      selection.collapse(two.firstChild, 1)
      expect(document.activeElement === other, "a selection that moves inside the host it is in does not ask for focus").toBe(true)
      selection.setBaseAndExtent(one.firstChild!, 0, one.firstChild!, 5)
      expect(document.activeElement === one).toBe(true)
      selection.removeAllRanges()
      other.focus()
      const range = document.createRange()
      range.setStart(two.firstChild!, 0)
      range.collapse(true)
      selection.addRange(range)
      expect(document.activeElement === two).toBe(true)
    } finally {
      app.unmount()
    }
  })
})
