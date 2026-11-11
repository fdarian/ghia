// The members that say where a box is: offsetParent, offsetLeft, offsetTop, clientLeft, clientTop and
// getClientRects, read from the box native laid out, as Base UI's tab indicator and composite lists read them.
import { describe, expect, it } from "vitest"
import { DOMRect, type PublicInstance } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function mount(ui: React.ReactElement) {
  const root = createTestRoot()
  root.render(ui)
  return root
}

describeNative("offsetParent, offsetLeft and offsetTop", () => {
  it("measure from the padding edge of the nearest positioned ancestor", () => {
    let outer: PublicInstance | null = null
    let positioned: PublicInstance | null = null
    let inner: PublicInstance | null = null
    let absolute: PublicInstance | null = null
    const root = mount(
      <div ref={(element) => { outer = element }} style={{ width: 300, height: 200, paddingLeft: 7 }}>
        <div
          ref={(element) => { positioned = element }}
          style={{ position: "relative", width: 100, height: 50, marginLeft: 11, marginTop: 13, borderWidth: 3, borderStyle: "solid" }}
        >
          <div ref={(element) => { inner = element }} style={{ width: 20, height: 20, marginLeft: 5, marginTop: 4 }} />
          <div ref={(element) => { absolute = element }} style={{ position: "absolute", left: 9, top: 6, width: 10, height: 10 }} />
        </div>
      </div>
    )
    try {
      expect(positioned!.offsetParent, "a static ancestor is skipped up to body").toBe(document.body)
      expect(positioned!.offsetLeft).toBe(18)
      expect(positioned!.offsetTop).toBe(13)
      expect(positioned!.clientLeft).toBe(3)
      expect(positioned!.clientTop).toBe(3)
      expect(inner!.offsetParent).toBe(positioned)
      expect(inner!.offsetLeft, "from the padding edge, inside the border").toBe(5)
      expect(inner!.offsetTop).toBe(4)
      expect(absolute!.offsetParent).toBe(positioned)
      expect(absolute!.offsetLeft).toBe(9)
      expect(absolute!.offsetTop).toBe(6)
      expect(outer!.offsetParent).toBe(document.body)
    } finally {
      root.unmount()
    }
  })

  it("add up through offsetParent to the position in the window", () => {
    let leaf: PublicInstance | null = null
    const root = mount(
      <div style={{ position: "relative", marginLeft: 10, marginTop: 20, width: 200, height: 200 }}>
        <div style={{ position: "relative", marginLeft: 30, marginTop: 40, width: 100, height: 100 }}>
          <div ref={(element) => { leaf = element }} style={{ marginLeft: 6, marginTop: 8, width: 10, height: 10 }} />
        </div>
      </div>
    )
    try {
      let left = 0
      let top = 0
      for (let element: PublicInstance | null = leaf; element !== null && element !== document.body; element = element.offsetParent as PublicInstance | null) {
        left += element.offsetLeft
        top += element.offsetTop
      }
      const rect = leaf!.getBoundingClientRect()
      expect(left).toBe(rect.left)
      expect(top).toBe(rect.top)
      expect(left).toBe(46)
      // The three top margins (20, 40 and 8) collapse into one of 40, as in CSS.
      expect(top).toBe(40)
    } finally {
      root.unmount()
    }
  })

  it("do not change when an ancestor scrolls", () => {
    let scroller: PublicInstance | null = null
    let row: PublicInstance | null = null
    const root = mount(
      <div
        ref={(element) => { scroller = element }}
        style={{ position: "relative", width: 100, height: 100, overflowY: "scroll", flexDirection: "column" }}
      >
        <div style={{ height: 80, flexShrink: 0 }} />
        <div ref={(element) => { row = element }} style={{ height: 80, flexShrink: 0 }} />
      </div>
    )
    try {
      expect(row!.offsetParent).toBe(scroller)
      expect(row!.offsetTop).toBe(80)
      scroller!.scrollTop = 50
      expect(scroller!.scrollTop).toBe(50)
      expect(row!.getBoundingClientRect().top).toBe(scroller!.getBoundingClientRect().top + 30)
      expect(row!.offsetTop, "the layout did not move").toBe(80)
    } finally {
      root.unmount()
    }
  })

  it("count a scroll in a static ancestor between the element and its offset parent as no move", () => {
    let middle: PublicInstance | null = null
    let leaf: PublicInstance | null = null
    const root = mount(
      <div style={{ position: "relative", width: 100, height: 100 }}>
        <div ref={(element) => { middle = element }} style={{ width: 100, height: 50, overflowY: "scroll", flexDirection: "column" }}>
          <div style={{ height: 40, flexShrink: 0 }} />
          <div ref={(element) => { leaf = element }} style={{ height: 40, flexShrink: 0 }} />
        </div>
      </div>
    )
    try {
      expect(leaf!.offsetTop).toBe(40)
      middle!.scrollTop = 25
      expect(leaf!.offsetTop).toBe(40)
    } finally {
      root.unmount()
    }
  })

  it("are null and 0 for an element with no box, and for html, body and a fixed element", () => {
    let none: PublicInstance | null = null
    let child: PublicInstance | null = null
    let fixed: PublicInstance | null = null
    const root = mount(
      <div style={{ width: 200, height: 200 }}>
        <div ref={(element) => { none = element }} style={{ display: "none" }}>
          <div ref={(element) => { child = element }} style={{ width: 10, height: 10 }} />
        </div>
        <div ref={(element) => { fixed = element }} style={{ position: "fixed", top: 5, left: 6, width: 10, height: 10 }} />
      </div>
    )
    try {
      expect(none!.offsetParent).toBeNull()
      expect(child!.offsetParent).toBeNull()
      expect(child!.offsetLeft).toBe(0)
      expect(child!.offsetTop).toBe(0)
      expect(child!.clientLeft).toBe(0)
      expect(document.body!.offsetParent).toBeNull()
      expect(document.documentElement!.offsetParent).toBeNull()
      expect(fixed!.offsetParent).toBeNull()
      expect(fixed!.offsetLeft, "from the window's origin").toBe(6)
      expect(fixed!.offsetTop).toBe(5)
    } finally {
      root.unmount()
    }
  })

  it("take a table part as the offset parent of a static element", () => {
    let cell: PublicInstance | null = null
    let content: PublicInstance | null = null
    const root = mount(
      <table>
        <tbody>
          <tr>
            <td ref={(element) => { cell = element }} style={{ width: 80, height: 40, padding: 0 }}>
              <div ref={(element) => { content = element }} style={{ width: 10, height: 10 }} />
            </td>
          </tr>
        </tbody>
      </table>
    )
    try {
      expect(content!.offsetParent).toBe(cell)
      expect(content!.offsetLeft).toBe(0)
    } finally {
      root.unmount()
    }
  })
})

describeNative("getClientRects", () => {
  it("is the border box as one DOMRect, and empty for an element with no box", () => {
    let box: PublicInstance | null = null
    let none: PublicInstance | null = null
    const root = mount(
      <div style={{ width: 200, height: 200 }}>
        <div ref={(element) => { box = element }} style={{ marginLeft: 12, marginTop: 9, width: 60, height: 30 }} />
        <div ref={(element) => { none = element }} style={{ display: "none" }} />
      </div>
    )
    try {
      const rects = box!.getClientRects()
      expect(rects.length).toBe(1)
      expect(rects[0]).toBeInstanceOf(DOMRect)
      expect(rects.item(0)).toBe(rects[0])
      expect(rects.item(1)).toBeNull()
      expect(rects[0].x).toBe(12)
      expect(rects[0].y).toBe(9)
      expect(rects[0].width).toBe(60)
      expect(rects[0].height).toBe(30)
      expect(rects[0].right).toBe(72)
      expect(Array.from(box!.getClientRects()).length).toBe(1)
      expect(none!.getClientRects().length).toBe(0)
    } finally {
      root.unmount()
    }
  })

  it("is the box in the window, so a transform moves it", () => {
    let box: PublicInstance | null = null
    const root = mount(<div ref={(element) => { box = element }} style={{ width: 40, height: 40, transform: "translateX(25px)" }} />)
    try {
      expect(box!.getClientRects()[0].x).toBe(25)
      expect(box!.getClientRects()[0].x).toBe(box!.getBoundingClientRect().x)
    } finally {
      root.unmount()
    }
  })
})
