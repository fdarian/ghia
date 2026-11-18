/** Where DOM positions are on screen, from the real paint pipeline: `Range` rects, the position at a point, and `Selection.modify` by line. */
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const LINE = 20
const TEXT = { fontSize: 16, lineHeight: `${LINE}px`, fontFamily: "Menlo" } as const

function measureColumn(): number {
  const root = createTestRoot()
  root.render(() => (
    <div highlight={{ query: "aaaaaaaaaa" }}>
      <div style={TEXT}>{"aaaaaaaaaa"}</div>
    </div>
  ))
  const width = root.renderer.getPaintedHighlights()[0]!.rects[0]!.width / 10
  root.unmount()
  return width
}

describe.skipIf(!hasNativeTestRenderer)("Solid DOM positions and painted text", () => {
  const COLUMN = measureColumn()
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function mountHost(content: () => unknown, width: number) {
    const root = createTestRoot()
    cleanups.push(() => root.unmount())
    root.render(() => (
      <div style={{ padding: 20, ...TEXT }}>
        <div contentEditable style={{ width }}>
          {content() as never}
        </div>
      </div>
    ))
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    const box = host.getBoundingClientRect()
    return { host, left: box.x, top: box.y }
  }

  /** `aaaa bbbb cccc dddd` in a box ten columns wide: it wraps after `bbbb `, the space hanging off the first row. */
  function wrapped() {
    const mounted = mountHost(() => "aaaa bbbb cccc dddd", 10 * COLUMN + 0.5)
    return { ...mounted, text: mounted.host.firstChild as Text }
  }

  function paragraphs(...lines: string[]) {
    const mounted = mountHost(() => lines.map((line) => <div>{line}</div>), 400)
    return { ...mounted, texts: [...mounted.host.children].map((child) => child.firstChild as Text) }
  }

  it("gives a rect for each line a range covers, and the caret as a collapsed range", () => {
    const { text, left } = wrapped()
    const range = document.createRange()
    range.setStart(text, 5)
    range.setEnd(text, 14)
    const [first, second, ...rest] = [...range.getClientRects()] as DOMRect[]
    expect(rest).toHaveLength(0)
    expect(first!.x).toBeCloseTo(left + 5 * COLUMN, 1)
    expect(second!.x).toBeCloseTo(left, 1)
    expect(second!.y - first!.y).toBeCloseTo(LINE, 1)
    expect(second!.width).toBeCloseTo(4 * COLUMN, 1)
    range.setStart(text, 3)
    range.collapse(true)
    const caret = range.getBoundingClientRect()
    expect(caret.width).toBe(0)
    expect(caret.x).toBeCloseTo(left + 3 * COLUMN, 1)
  })

  it("finds the text node and offset at a point, and puts a point right of a wrapped row at its end", () => {
    const { text, left, top } = wrapped()
    const second = document.caretPositionFromPoint(left + 2.4 * COLUMN, top + LINE + 8)
    expect([second?.offsetNode, second?.offset]).toEqual([text, 12])
    const end = document.caretPositionFromPoint(left + 40 * COLUMN, top + 8)
    expect([end?.offsetNode, end?.offset]).toEqual([text, 9])
  })

  it("keeps the column across a shorter line with Selection.modify", () => {
    const { texts } = paragraphs("the first line", "ab", "the third line")
    const selection = document.getSelection()
    selection.collapse(texts[0]!, 9)
    selection.modify("move", "forward", "line")
    expect([selection.focusNode, selection.focusOffset]).toEqual([texts[1], 2])
    selection.modify("move", "forward", "line")
    expect([selection.focusNode, selection.focusOffset]).toEqual([texts[2], 9])
    selection.modify("move", "backward", "line")
    selection.modify("move", "backward", "line")
    expect([selection.focusNode, selection.focusOffset]).toEqual([texts[0], 9])
  })

  it("moves through an empty paragraph by line: a line of its own, with the caret before its line break, and the ends of the host included", () => {
    const mounted = mountHost(
      () => [<div>the first line</div>, <div><br /></div>, <div>the long third line</div>, <div><br /></div>],
      400
    )
    const [first, empty, third, trailing] = [...mounted.host.children] as HTMLElement[]
    const selection = document.getSelection()
    const focus = () => [selection.focusNode, selection.focusOffset]
    selection.collapse(first!.firstChild, 9)
    selection.modify("move", "forward", "line")
    expect(focus()).toEqual([empty, 0])
    selection.modify("move", "forward", "line")
    expect(focus()).toEqual([third!.firstChild, 9])
    selection.modify("move", "forward", "line")
    expect(focus()).toEqual([trailing, 0])
    selection.modify("move", "forward", "line")
    expect(focus()).toEqual([trailing, 0])
    selection.modify("move", "backward", "line")
    selection.modify("move", "backward", "line")
    expect(focus()).toEqual([empty, 0])
    selection.modify("move", "backward", "line")
    expect(focus()).toEqual([first!.firstChild, 9])
  })

  it("goes to the ends of the painted row for lineboundary", () => {
    const { text } = wrapped()
    const selection = document.getSelection()
    selection.collapse(text, 3)
    selection.modify("move", "forward", "lineboundary")
    expect(selection.focusOffset).toBe(9)
    selection.collapse(text, 13)
    selection.modify("move", "backward", "lineboundary")
    expect(selection.focusOffset).toBe(10)
  })
})
