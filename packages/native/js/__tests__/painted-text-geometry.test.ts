import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../dom-globals.js"
import { CaretPosition } from "../editing/caret-position.js"
import { document, installElementSource } from "../events/window-target.js"
import { createRendererState } from "../renderer-state.js"
import type { Text } from "../dom/nodes.js"
import type { CaretPoint } from "../host.js"
import { asNode, box, el, FakeEl, scriptedWindow, tx, type FakeTx, type ScriptedWindow } from "./fixtures/painted-dom.js"

const n = asNode

describe("painted text geometry (JS half)", () => {
  const selection = document.getSelection()
  const cleanups: Array<() => void> = []
  let window: ScriptedWindow
  let elements: Map<number, FakeEl>

  beforeEach(() => {
    window = scriptedWindow()
    elements = new Map()
    cleanups.push(createRendererState(window.renderer).attach({ onSelectionChange: undefined }).detach)
    cleanups.push(installElementSource(window, (id) => elements.get(id)))
    vi.spyOn(document, "createTextNode").mockImplementation((data: string) => tx(window, data) as unknown as Text)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    selection.collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** A mounted element, which `elementOf` finds by id as native names the container of a paragraph. */
  function mounted(element: FakeEl): FakeEl {
    elements.set(element.id, element)
    for (const kid of element.kids) if (kid instanceof FakeEl) mounted(kid)
    return element
  }

  describe("Range.getClientRects and getBoundingClientRect", () => {
    it("asks native for the part of a text node the range selects, one rect per line fragment", () => {
      const text = tx(window, "hello world")
      mounted(el(window, "p", text))
      window.rects = (_id, start, end) => [
        { x: start * 10, y: 0, width: 30, height: 16 },
        { x: 0, y: 20, width: (end - 6) * 10, height: 16 },
      ]
      const range = document.createRange()
      range.setStart(n(text), 3)
      range.setEnd(n(text), 8)
      const rects = range.getClientRects()
      expect(window.rectCalls).toEqual([[text.id, 3, text.id, 8]])
      expect(rects.map((rect) => [rect.x, rect.y, rect.width, rect.height])).toEqual([
        [30, 0, 30, 16],
        [0, 20, 20, 16],
      ])
      expect(rects.item(1)?.top).toBe(20)
    })

    it("is the union of the line fragments for getBoundingClientRect, and an empty rect when nothing painted", () => {
      const text = tx(window, "hello world")
      mounted(el(window, "p", text))
      window.rects = () => [
        { x: 30, y: 0, width: 50, height: 16 },
        { x: 0, y: 20, width: 20, height: 16 },
      ]
      const range = document.createRange()
      range.setStart(n(text), 3)
      range.setEnd(n(text), 8)
      const bounds = range.getBoundingClientRect()
      expect([bounds.x, bounds.y, bounds.width, bounds.height]).toEqual([0, 0, 80, 36])

      window.rects = () => []
      expect(range.getClientRects()).toHaveLength(0)
      const none = range.getBoundingClientRect()
      expect([none.x, none.y, none.width, none.height]).toEqual([0, 0, 0, 0])
    })

    it("reads a collapsed range in a text node as the caret: one rect with no width", () => {
      const text = tx(window, "abc")
      mounted(el(window, "p", text))
      window.rects = (_id, start, end) => (start === end ? [{ x: start * 10, y: 0, width: 0, height: 16 }] : [])
      const range = document.createRange()
      range.setStart(n(text), 2)
      range.collapse(true)
      expect(range.getBoundingClientRect().width).toBe(0)
      expect(range.getBoundingClientRect().x).toBe(20)
      expect(window.rectCalls[0]).toEqual([text.id, 2, text.id, 2])
    })

    it("has no rects for a collapsed range in an element, or an empty part of a text", () => {
      const text = tx(window, "abc")
      const paragraph = mounted(el(window, "p", text))
      window.rects = () => [{ x: 1, y: 1, width: 1, height: 1 }]
      const collapsed = document.createRange()
      collapsed.setStart(n(paragraph), 1)
      collapsed.collapse(true)
      expect(collapsed.getClientRects()).toHaveLength(0)
      expect(window.rectCalls).toEqual([])
    })

    it("reads each text node of a range over several nodes, with its own start and end offsets", () => {
      const first = tx(window, "ab")
      const second = tx(window, "cd")
      const third = tx(window, "ef")
      mounted(el(window, "p", first, el(window, "span", second), third))
      window.rects = (id, start, end) => [{ x: id * 100 + start, y: 0, width: end - start, height: 16 }]
      const range = document.createRange()
      range.setStart(n(first), 1)
      range.setEnd(n(third), 1)
      range.getClientRects()
      expect(window.rectCalls).toEqual([
        [first.id, 1, first.id, 2],
        [second.id, 0, second.id, 2],
        [third.id, 0, third.id, 1],
      ])
    })

    it("adds the border box of an element the range selects whole, once, and none of the elements inside it", () => {
      const first = tx(window, "ab")
      const inner = tx(window, "cd")
      const nested = el(window, "i", tx(window, "x"))
      const outer = el(window, "span", inner, nested)
      const last = tx(window, "ef")
      mounted(el(window, "p", first, outer, last))
      window.bounds.set(outer.id, box(20, 0, 40, 16))
      window.bounds.set(nested.id, box(40, 0, 10, 16))
      window.rects = (id) => [{ x: id, y: 0, width: 1, height: 1 }]
      const range = document.createRange()
      range.setStart(n(first), 0)
      range.setEnd(n(last), 2)
      const rects = range.getClientRects()
      expect(rects.map((rect) => rect.width)).toEqual([1, 40, 1, 1, 1])
      expect(rects[1]?.x).toBe(20)
    })

    it("gives a text node of a range that starts and ends in the same node only its own part", () => {
      const text = tx(window, "abcdef")
      mounted(el(window, "p", text))
      window.rects = () => [{ x: 0, y: 0, width: 1, height: 1 }]
      const range = document.createRange()
      range.setStart(n(text), 4)
      range.setEnd(n(text), 4)
      expect(range.getClientRects()).toHaveLength(1)
      range.setEnd(n(text), 5)
      range.getClientRects()
      expect(window.rectCalls.at(-1)).toEqual([text.id, 4, text.id, 5])
    })
  })

  describe("document.caretPositionFromPoint and caretRangeFromPoint", () => {
    it("answers with the text node native names, found under the element that paints it", () => {
      const first = tx(window, "ab")
      const second = tx(window, "cd")
      const paragraph = mounted(el(window, "p", first, el(window, "b", second)))
      window.point = (x, y): CaretPoint => ({ nodeId: second.id, containerId: paragraph.id, offset: 1, x })
      const position = document.caretPositionFromPoint(12, 8)
      expect(window.pointCalls).toEqual([[12, 8]])
      expect(position).toBeInstanceOf(CaretPosition)
      expect(position?.offsetNode).toBe(n(second))
      expect(position?.offset).toBe(1)
    })

    it("gives the caret rect of the position from getClientRect", () => {
      const text = tx(window, "ab")
      const paragraph = mounted(el(window, "p", text))
      window.point = () => ({ nodeId: text.id, containerId: paragraph.id, offset: 1, x: 10 })
      window.rects = (_id, start, end) => (start === end ? [{ x: 10, y: 4, width: 0, height: 16 }] : [])
      const rect = document.caretPositionFromPoint(10, 8)?.getClientRect()
      expect([rect?.x, rect?.y, rect?.width, rect?.height]).toEqual([10, 4, 0, 16])
    })

    it("is null where nothing painted, and caretRangeFromPoint is a collapsed range at the position", () => {
      const text = tx(window, "ab")
      const paragraph = mounted(el(window, "p", text))
      expect(document.caretPositionFromPoint(1, 1)).toBeNull()
      expect(document.caretRangeFromPoint(1, 1)).toBeNull()
      window.point = () => ({ nodeId: text.id, containerId: paragraph.id, offset: 2, x: 20 })
      const range = document.caretRangeFromPoint(1, 1)
      expect([range?.startContainer, range?.startOffset, range?.collapsed]).toEqual([n(text), 2, true])
    })

    it("rejects a coordinate that is not a finite number, and cannot be constructed", () => {
      expect(() => document.caretPositionFromPoint(Number.NaN, 0)).toThrow(TypeError)
      expect(() => new (CaretPosition as unknown as new () => unknown)()).toThrow(TypeError)
    })

    it("fails loudly when native names a text its element does not hold", () => {
      const text = tx(window, "ab")
      const paragraph = mounted(el(window, "p", text))
      window.point = () => ({ nodeId: 999_999, containerId: paragraph.id, offset: 0, x: 0 })
      expect(() => document.caretPositionFromPoint(1, 1)).toThrow(/no such text/)
    })
  })

  describe("Selection.modify by line", () => {
    function editor(...paragraphs: string[]): { host: FakeEl; texts: FakeTx[] } {
      const texts = paragraphs.map((content) => tx(window, content))
      const host = el(window, "div", ...texts.map((text) => el(window, "p", text)))
      host.props.contenteditable = "true"
      mounted(host)
      return { host, texts }
    }

    function at(text: FakeTx, offset: number, x: number): CaretPoint {
      return { nodeId: text.id, containerId: text.parent?.id ?? 0, offset, x }
    }

    it("keeps the goal x across consecutive moves and asks for the caret's own the first time", () => {
      const { texts } = editor("a long first line", "ab", "a long third line")
      selection.collapse(n(texts[0]!), 12)
      const results = [at(texts[1]!, 2, 20), at(texts[2]!, 12, 120)]
      window.move = () => results.shift() ?? null
      selection.modify("move", "forward", "line")
      selection.modify("move", "forward", "line")
      expect(window.moveCalls).toEqual([
        { nodeId: texts[0]!.id, offset: 12, op: "lineDown", goalX: null },
        { nodeId: texts[1]!.id, offset: 2, op: "lineDown", goalX: 20 },
      ])
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(texts[2]!), 12])
    })

    it("forgets the goal x when anything else changes the selection", () => {
      const { texts } = editor("one", "two", "three")
      selection.collapse(n(texts[0]!), 1)
      window.move = (id) => (id === texts[0]!.id ? at(texts[1]!, 1, 55) : at(texts[2]!, 1, 55))
      selection.modify("move", "forward", "line")
      selection.collapse(n(texts[1]!), 1)
      selection.modify("move", "forward", "line")
      expect(window.moveCalls.map((call) => call.goalX)).toEqual([null, null])
      selection.modify("move", "backward", "character")
      selection.modify("move", "forward", "line")
      expect(window.moveCalls.at(-1)?.goalX).toBeNull()
    })

    it("moves up with backward, extends with the goal x, and keeps the anchor", () => {
      const { texts } = editor("one", "two", "three")
      selection.collapse(n(texts[2]!), 2)
      window.move = (id) => (id === texts[2]!.id ? at(texts[1]!, 2, 30) : at(texts[0]!, 2, 30))
      selection.modify("extend", "backward", "line")
      selection.modify("extend", "backward", "line")
      expect(window.moveCalls.map((call) => [call.op, call.goalX])).toEqual([
        ["lineUp", null],
        ["lineUp", 30],
      ])
      expect([selection.anchorNode, selection.anchorOffset]).toEqual([n(texts[2]!), 2])
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(texts[0]!), 2])
      expect(selection.direction).toBe("backwards")
    })

    it("goes to the start of the host's text going up from the first line, and the end going down from the last", () => {
      const { texts } = editor("one", "two")
      selection.collapse(n(texts[0]!), 2)
      selection.modify("move", "backward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(texts[0]!), 0])
      selection.collapse(n(texts[0]!), 1)
      selection.modify("move", "forward", "line")
      selection.collapse(n(texts[1]!), 1)
      selection.modify("move", "forward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(texts[1]!), 3])
      window.moveCalls.length = 0
      selection.modify("move", "forward", "line")
      expect(selection.focusOffset).toBe(3)
    })

    it("does not leave the editing host: a line native finds outside it is none", () => {
      const inside = tx(window, "inside")
      const outside = tx(window, "outside")
      const host = el(window, "div", el(window, "p", inside))
      host.props.contenteditable = "true"
      mounted(host)
      const page = mounted(el(window, "section", host, el(window, "p", outside)))
      window.move = () => at(outside, 3, 10)
      selection.collapse(n(inside), 2)
      selection.modify("move", "forward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(inside), 6])
      expect(page.kids).toHaveLength(2)
    })

    it("does nothing at a position with no text next to it", () => {
      const host = el(window, "div", el(window, "p"))
      host.props.contenteditable = "true"
      mounted(host)
      selection.collapse(n(host.kids[0]!), 0)
      selection.modify("move", "forward", "line")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(host.kids[0]!), 0])
      expect(window.moveCalls).toEqual([])
    })
  })

  describe("Selection.modify to a boundary", () => {
    it("moves to the end and the start of the line native finds, extending from the focus", () => {
      const text = tx(window, "wrapped line of text")
      const host = el(window, "div", el(window, "p", text))
      host.props.contenteditable = "true"
      mounted(host)
      window.move = (_id, _offset, op) =>
        op === "lineEnd" ? { nodeId: text.id, containerId: text.parent?.id ?? 0, offset: 8, x: 80 } : { nodeId: text.id, containerId: text.parent?.id ?? 0, offset: 0, x: 0 }
      selection.collapse(n(text), 3)
      selection.modify("move", "forward", "lineboundary")
      expect(selection.focusOffset).toBe(8)
      selection.modify("extend", "backward", "lineboundary")
      expect([selection.anchorOffset, selection.focusOffset]).toEqual([8, 0])
      expect(window.moveCalls.map((call) => [call.op, call.goalX])).toEqual([
        ["lineEnd", null],
        ["lineStart", null],
      ])
    })

    it("moves to the first or the last text position of the host for documentboundary, without native", () => {
      const first = tx(window, "one")
      const last = tx(window, "two")
      const host = el(window, "div", el(window, "p", first), el(window, "p", last))
      host.props.contenteditable = "true"
      mounted(host)
      selection.collapse(n(first), 1)
      selection.modify("move", "forward", "documentboundary")
      expect([selection.focusNode, selection.focusOffset]).toEqual([n(last), 3])
      selection.modify("extend", "backward", "documentboundary")
      expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([n(last), 3, n(first), 0])
      expect(window.moveCalls).toEqual([])
    })

    it("still refuses the granularities that need paragraphs and sentences", () => {
      const text = tx(window, "one")
      mounted(el(window, "p", text))
      selection.collapse(n(text), 1)
      for (const granularity of ["sentence", "paragraph", "sentenceboundary", "paragraphboundary"]) {
        expect(() => selection.modify("move", "forward", granularity)).toThrow(/not supported/)
      }
    })
  })
})
