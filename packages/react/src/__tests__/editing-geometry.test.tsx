/// Where DOM positions are on screen, from the real paint pipeline: `Range` rects, the position at a
/// point, and `Selection.modify` by line. Menlo has one advance for every character, so a position
/// is a column and a wrapped row is as wide as its characters are many.
import React from "react"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const LINE = 20
const TEXT = { fontSize: 16, lineHeight: `${LINE}px`, fontFamily: "Menlo" } as const

function measureColumn(): number {
  const root = createTestRoot()
  root.render(
    <div highlight={{ query: "aaaaaaaaaa" }}>
      <div style={TEXT}>{"aaaaaaaaaa"}</div>
    </div>
  )
  const width = root.renderer.getPaintedHighlights()[0]!.rects[0]!.width / 10
  root.unmount()
  return width
}

const COLUMN = measureColumn()

describeNative("DOM positions and painted text (React)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function mount(node: React.ReactNode) {
    const root = createTestRoot()
    cleanups.push(() => root.unmount())
    root.render(node)
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    return { host, renderer: root.renderer, left: host.getBoundingClientRect().x, top: host.getBoundingClientRect().y }
  }

  /** `aaaa bbbb cccc dddd` in a box ten columns wide: it wraps after `bbbb `, the space hanging off the first row. */
  function wrapped() {
    const mounted = mount(
      <div style={{ padding: 20, ...TEXT }}>
        <div contentEditable style={{ width: 10 * COLUMN + 0.5 }}>
          aaaa bbbb cccc dddd
        </div>
      </div>
    )
    return { ...mounted, text: mounted.host.firstChild as Text }
  }

  function paragraphs(...lines: string[]) {
    const mounted = mount(
      <div style={{ padding: 20, ...TEXT }}>
        <div contentEditable style={{ width: 400 }}>
          {lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      </div>
    )
    const texts = [...mounted.host.children].map((child) => child.firstChild as Text)
    return { ...mounted, texts }
  }

  describe("Range rects", () => {
    it("gives one rect for each line a range covers, the content area of the font, and a union for the bounding rect", () => {
      const { text, left } = wrapped()
      const range = document.createRange()
      range.setStart(text, 5)
      range.setEnd(text, 14)
      const rects = [...range.getClientRects()]
      expect(rects).toHaveLength(2)
      const [first, second] = rects as [DOMRect, DOMRect]
      expect(first.x).toBeCloseTo(left + 5 * COLUMN, 1)
      // The space that hangs off the end of the row is part of the fragment, as it is of the selection wash.
      expect(first.width).toBeCloseTo(5 * COLUMN, 1)
      expect(second.x).toBeCloseTo(left, 1)
      expect(second.width).toBeCloseTo(4 * COLUMN, 1)
      expect(second.y - first.y).toBeCloseTo(LINE, 1)
      expect(first.height).toBeCloseTo(second.height, 3)
      expect(first.height).toBeGreaterThan(10)
      expect(first.height).toBeLessThan(LINE + 1)
      const union = range.getBoundingClientRect()
      expect(union.top).toBeCloseTo(first.top, 3)
      expect(union.bottom).toBeCloseTo(second.bottom, 3)
      expect(union.left).toBeCloseTo(left, 1)
    })

    it("is the caret for a collapsed range in a text: no width, at the column of the offset", () => {
      const { text, left, top } = wrapped()
      const range = document.createRange()
      range.setStart(text, 3)
      range.collapse(true)
      const rects = [...range.getClientRects()]
      expect(rects).toHaveLength(1)
      expect(rects[0]!.width).toBe(0)
      expect(rects[0]!.x).toBeCloseTo(left + 3 * COLUMN, 1)
      expect(rects[0]!.y).toBeGreaterThanOrEqual(top)
      range.setStart(text, 12)
      range.collapse(true)
      const second = range.getBoundingClientRect()
      expect(second.x).toBeCloseTo(left + 2 * COLUMN, 1)
      expect(second.y).toBeCloseTo(rects[0]!.y + LINE, 1)
    })

    it("covers the nodes between the two ends, and the border box of an element it selects whole", () => {
      const { host, left } = mount(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 400 }}>
            ab<b>cd</b>ef
          </div>
        </div>
      )
      const [first, bold, last] = [...host.childNodes] as [Text, HTMLElement, Text]
      const partial = document.createRange()
      partial.setStart(first, 1)
      partial.setEnd(last, 1)
      const rects = [...partial.getClientRects()]
      // "b", "cd" (inside the selected <b>, which adds its box too), "e".
      expect(rects.map((rect) => Math.round(rect.width / COLUMN))).toEqual([1, 2, 2, 1])
      expect(rects[1]!.x).toBeCloseTo(left + 2 * COLUMN, 1)
      expect(rects[1]!.x).toBeCloseTo(bold.getBoundingClientRect().x, 1)
    })

    it("has no rects for a collapsed range in an element, and none for text that did not paint", () => {
      const { host } = wrapped()
      const range = document.createRange()
      range.setStart(host, 0)
      range.collapse(true)
      expect(range.getClientRects()).toHaveLength(0)
      expect(range.getBoundingClientRect().width).toBe(0)
    })

    it("sees a change made earlier in the same event handler", () => {
      const { host, renderer, text } = wrapped()
      host.focus()
      document.getSelection().collapse(text, 4)
      const seen: number[] = []
      host.addEventListener("input", () => {
        const range = document.createRange()
        range.setStart(host.firstChild!, 5)
        range.collapse(true)
        seen.push(range.getBoundingClientRect().x)
      })
      const before = document.createRange()
      before.setStart(text, 5)
      before.collapse(true)
      const x = before.getBoundingClientRect().x
      renderer.simulateKeystrokes("W")
      expect(host.textContent).toBe("aaaaW bbbb cccc dddd")
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBeCloseTo(x, 1)
      const after = document.createRange()
      after.setStart(host.firstChild!, 5)
      after.collapse(true)
      expect(after.getBoundingClientRect().x).toBeCloseTo(x, 1)
    })
  })

  describe("caretPositionFromPoint", () => {
    it("finds the text node and the character boundary nearest the point, row by row", () => {
      const { text, left, top } = wrapped()
      const second = document.caretPositionFromPoint(left + 2.4 * COLUMN, top + LINE + 8)
      expect([second?.offsetNode, second?.offset]).toEqual([text, 12])
      const first = document.caretPositionFromPoint(left + 6.6 * COLUMN, top + 8)
      expect([first?.offsetNode, first?.offset]).toEqual([text, 7])
      const rect = first?.getClientRect()
      expect(rect?.width).toBe(0)
      expect(rect?.x).toBeCloseTo(left + 7 * COLUMN, 1)
    })

    it("puts a point right of a wrapped row at its end, not at the start of the next row", () => {
      const { text, left, top } = wrapped()
      const end = document.caretPositionFromPoint(left + 40 * COLUMN, top + 8)
      expect([end?.offsetNode, end?.offset]).toEqual([text, 9])
      const last = document.caretPositionFromPoint(left + 40 * COLUMN, top + LINE + 8)
      expect([last?.offsetNode, last?.offset]).toEqual([text, 19])
    })

    it("gives a collapsed range from caretRangeFromPoint and goes through the inline elements around the text", () => {
      const { host, left, top } = mount(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 400 }}>
            ab<b>cd</b>ef
          </div>
        </div>
      )
      const bold = host.querySelector("b")!.firstChild!
      const range = document.caretRangeFromPoint(left + 2.6 * COLUMN, top + 8)
      expect([range?.startContainer, range?.startOffset, range?.collapsed]).toEqual([bold, 1, true])
    })
  })

  describe("Selection.modify by line", () => {
    it("keeps the column across a shorter line and comes back to it", () => {
      const { texts, left } = paragraphs("the first line", "ab", "the third line")
      const selection = document.getSelection()
      selection.collapse(texts[0]!, 9)
      selection.modify("move", "forward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([texts[1], 2])
      selection.modify("move", "forward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([texts[2], 9])
      selection.modify("move", "backward", "line")
      selection.modify("move", "backward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([texts[0], 9])
      const caret = document.caretPositionFromPoint(left + 9 * COLUMN + 1, 28)
      expect(caret?.offset).toBe(9)
    })

    it("forgets the column once the selection changes another way", () => {
      const { texts } = paragraphs("the first line", "ab", "the third line")
      const selection = document.getSelection()
      selection.collapse(texts[0]!, 9)
      selection.modify("move", "forward", "line")
      selection.modify("move", "backward", "character")
      selection.modify("move", "forward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([texts[2], 1])
    })

    it("moves by the rows of a paragraph that wraps, then leaves it, and stops at the edges of the host", () => {
      const { text, host } = (() => {
        const mounted = wrapped()
        return { text: mounted.text, host: mounted.host }
      })()
      const selection = document.getSelection()
      selection.collapse(text, 12)
      selection.modify("move", "backward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([text, 2])
      selection.modify("move", "forward", "line")
      expect(selection.focusOffset).toBe(12)
      selection.modify("move", "forward", "line")
      expect(selection.focusOffset).toBe(19)
      selection.modify("move", "forward", "line")
      expect(selection.focusOffset).toBe(19)
      selection.modify("extend", "backward", "line")
      expect([selection.anchorOffset, selection.focusOffset]).toEqual([19, 9])
      expect(host.contains(selection.focusNode)).toBe(true)
    })

    it("goes to the start and the end of the painted row for lineboundary, before the space that hangs off a row", () => {
      const { text } = wrapped()
      const selection = document.getSelection()
      selection.collapse(text, 3)
      selection.modify("move", "forward", "lineboundary")
      expect(selection.focusOffset).toBe(9)
      selection.modify("move", "backward", "lineboundary")
      expect(selection.focusOffset).toBe(0)
      selection.collapse(text, 13)
      selection.modify("move", "backward", "lineboundary")
      expect(selection.focusOffset).toBe(10)
      selection.modify("move", "forward", "lineboundary")
      expect(selection.focusOffset).toBe(19)
    })

    it("goes to the first and the last position of the host for documentboundary", () => {
      const { texts } = paragraphs("one", "two", "three")
      const selection = document.getSelection()
      selection.collapse(texts[1]!, 1)
      selection.modify("move", "forward", "documentboundary")
      expect([selection.focusNode, selection.focusOffset]).toEqual([texts[2], 5])
      selection.modify("extend", "backward", "documentboundary")
      expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([
        texts[2],
        5,
        texts[0],
        0,
      ])
    })
  })
})
