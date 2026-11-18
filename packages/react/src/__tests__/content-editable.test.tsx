// contentEditable: the reflected property, isContentEditable, and an editing host as a focus target and as :read-write.
import { describe, expect, it } from "vitest"
import type { PublicInstance } from "@ghia/native/host"
import { document } from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const size = { width: 80, height: 24 }

describeNative("contentEditable", () => {
  it("makes an editing host that focus() reaches, and leaves what is inside it to the host", () => {
    let host: PublicInstance | null = null
    let inside: PublicInstance | null = null
    let island: PublicInstance | null = null
    let nested: PublicInstance | null = null
    let plain: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div style={{ width: 300, height: 200 }}>
        <div ref={(element) => { host = element }} contentEditable style={size}>
          <span ref={(element) => { inside = element }}>text</span>
          <div ref={(element) => { island = element }} contentEditable={false} style={size}>
            <div ref={(element) => { nested = element }} contentEditable="plaintext-only" style={size} />
          </div>
        </div>
        <div ref={(element) => { plain = element }} style={size} />
      </div>
    )
    try {
      expect(host!.contentEditable).toBe("true")
      expect(host!.getAttribute("contenteditable")).toBe("true")
      expect(host!.isContentEditable).toBe(true)
      expect(inside!.isContentEditable).toBe(true)
      expect(island!.contentEditable).toBe("false")
      expect(island!.isContentEditable).toBe(false)
      expect(nested!.contentEditable).toBe("plaintext-only")
      expect(nested!.isContentEditable).toBe(true)
      expect(plain!.contentEditable).toBe("inherit")
      expect(plain!.isContentEditable).toBe(false)

      expect(host!.tabIndex).toBe(0)
      expect(inside!.tabIndex).toBe(-1)

      host!.focus()
      expect(document.activeElement === host).toBe(true)
      inside!.focus()
      expect(document.activeElement === host, "text inside a host is not a focus target of its own").toBe(true)
      plain!.focus()
      expect(document.activeElement === host).toBe(true)
      nested!.focus()
      expect(document.activeElement === nested, "an editable element under a false island is a host").toBe(true)
    } finally {
      root.unmount()
    }
  })

  it("follows the prop and the property, and :read-write follows with it", () => {
    let box: PublicInstance | null = null
    let child: PublicInstance | null = null
    const root = createTestRoot()
    const view = (editable: boolean | undefined) => (
      <div style={{ width: 300, height: 200 }}>
        <div ref={(element) => { box = element }} contentEditable={editable} style={size}>
          <span ref={(element) => { child = element }} />
        </div>
      </div>
    )
    try {
      root.render(view(undefined))
      expect(box!.matches(":read-only")).toBe(true)
      box!.focus()
      expect(document.activeElement === box).toBe(false)

      root.render(view(true))
      expect(box!.matches(":read-write") && child!.matches(":read-write")).toBe(true)
      box!.focus()
      expect(document.activeElement === box).toBe(true)

      root.render(view(false))
      expect(box!.getAttribute("contenteditable")).toBe("false")
      expect(box!.matches(":read-only") && child!.matches(":read-only")).toBe(true)

      box!.contentEditable = "TRUE"
      expect(box!.getAttribute("contenteditable")).toBe("true")
      expect(child!.isContentEditable).toBe(true)
      box!.contentEditable = "inherit"
      expect(box!.hasAttribute("contenteditable")).toBe(false)
      expect(box!.isContentEditable).toBe(false)
    } finally {
      root.unmount()
    }
  })

  it("throws a SyntaxError for text that is not a keyword", () => {
    let box: PublicInstance | null = null
    const root = createTestRoot()
    root.render(<div ref={(element) => { box = element }} contentEditable style={size} />)
    try {
      expect(() => {
        box!.contentEditable = "yes"
      }).toThrowError(expect.objectContaining({ name: "SyntaxError" }))
      expect(box!.contentEditable).toBe("true")
    } finally {
      root.unmount()
    }
  })

  it("takes focus when code sets the selection inside it, as Chrome does, and leaves a selection that stays in it alone", () => {
    let one: PublicInstance | null = null
    let two: PublicInstance | null = null
    let other: PublicInstance | null = null
    const root = createTestRoot()
    root.render(
      <div style={{ width: 300, height: 200 }}>
        <div ref={(element) => { one = element }} contentEditable style={size}>first</div>
        <div ref={(element) => { two = element }} contentEditable style={size}>second</div>
        <button ref={(element) => { other = element }} style={size}>other</button>
      </div>
    )
    try {
      const selection = document.getSelection()
      selection.collapse(one!.firstChild, 2)
      expect(document.activeElement === one).toBe(true)
      selection.collapse(two!.firstChild, 3)
      expect(document.activeElement === two).toBe(true)
      other!.focus()
      selection.collapse(two!.firstChild, 1)
      expect(document.activeElement === other, "a selection that moves inside the host it is in does not ask for focus").toBe(true)
      selection.setBaseAndExtent(one!.firstChild!, 0, one!.firstChild!, 5)
      expect(document.activeElement === one).toBe(true)
      selection.removeAllRanges()
      other!.focus()
      const range = document.createRange()
      range.setStart(two!.firstChild!, 0)
      range.collapse(true)
      selection.addRange(range)
      expect(document.activeElement === two).toBe(true)
    } finally {
      root.unmount()
    }
  })
})
