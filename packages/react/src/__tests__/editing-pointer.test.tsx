/// The pointer in an editing host: a click puts the caret at the character under it, a drag extends the selection, double and triple clicks select a word and a block, and
/// what the painted selection (a drag over text outside a host) keeps. Through the real GPUI pipeline: native finds the position, JS makes the selection. Menlo has one advance for every character, so a position is a column.
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

describeNative("the pointer in an editing host (React)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** A host of `lines` (one paragraph each) that is `columns` wide, with text above it and a button below. Not focused. */
  function mount(lines: string[], columns = 40) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    root.render(
      <div style={{ padding: 20, ...TEXT }}>
        <div id="outside">outside text</div>
        <div contentEditable style={{ width: columns * COLUMN + 0.5 }}>
          {lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
        <button id="other">other</button>
      </div>
    )
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    return harness(root.renderer, host)
  }

  function harness(renderer: ReturnType<typeof createTestRoot>["renderer"], host: HTMLElement) {
    const rect = host.getBoundingClientRect()
    const selection = document.getSelection()
    /** The point of the boundary before column `column` of row `row` of the host, a quarter of a character in so that it is the nearest. */
    const at = (row: number, column: number) => [rect.x + column * COLUMN + COLUMN / 4, rect.y + row * LINE + LINE / 2] as const
    const down = (point: readonly [number, number], count = 1, modifiers?: string) => {
      renderer.flush()
      renderer.native.simulateMouseDown(point[0], point[1], 0, modifiers, count)
      renderer.flush()
    }
    const move = (point: readonly [number, number]) => {
      renderer.native.simulateMouseMove(point[0], point[1])
      renderer.flush()
    }
    const up = (point: readonly [number, number], count = 1) => {
      renderer.native.simulateMouseUp(point[0], point[1], 0, undefined, count)
      renderer.flush()
    }
    /** The clicks of a `count`-fold click: a press and a release for each. */
    const click = (point: readonly [number, number], count = 1, modifiers?: string) => {
      for (let n = 1; n <= count; n++) {
        down(point, n, modifiers)
        up(point, n)
      }
    }
    return {
      host,
      renderer,
      rect,
      selection,
      at,
      down,
      move,
      up,
      click,
      texts: () => [...host.children].map((child) => child.firstChild as Text),
      state: () => [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset],
      shown: () => {
        renderer.drawFrame()
        renderer.drawFrame()
      },
    }
  }

  /** Two paragraphs, the first wrapping after `bbbb `: rows `aaaa bbbb ` and `cccc dddd`, then `ee ff`. */
  const wrapped = () => mount(["aaaa bbbb cccc dddd", "ee ff"], 10)

  describe("a click", () => {
    it("puts the caret at the character under it, painted there", () => {
      const { host, texts, click, at, state, shown, renderer, rect } = mount(["hello world", "second line"])
      host.focus()
      click(at(0, 4))
      expect(state()).toEqual([texts()[0], 4, texts()[0], 4])
      shown()
      const caret = renderer.getPaintedNodeSelection().caret!
      expect(caret.rect.x).toBeCloseTo(rect.x + 4 * COLUMN, 1)
      expect(caret.rect.y).toBeCloseTo(rect.y, 1)

      click(at(1, 7))
      expect(state()).toEqual([texts()[1], 7, texts()[1], 7])
      shown()
      const moved = renderer.getPaintedNodeSelection().caret!
      expect(moved.rect.x).toBeCloseTo(rect.x + 7 * COLUMN, 1)
      expect(moved.rect.y).toBeCloseTo(rect.y + LINE, 1)
    })

    it("puts the caret on the row it wrapped to", () => {
      const { texts, host, click, at, state } = wrapped()
      host.focus()
      click(at(1, 3))
      expect(state()).toEqual([texts()[0], 13, texts()[0], 13])
    })

    it("in a host that has no focus focuses it, with the caret at the point and not at the start", () => {
      const { host, texts, click, at, state, shown, renderer, rect } = mount(["hello world", "second line"])
      const seen: Array<[Node | null, number]> = []
      host.addEventListener("focusin", () => seen.push([document.getSelection().focusNode, document.getSelection().focusOffset]))
      expect(document.activeElement).not.toBe(host)
      click(at(0, 6))
      expect(document.activeElement).toBe(host)
      expect(state()).toEqual([texts()[0], 6, texts()[0], 6])
      // The selection was already there when the focus event was delivered.
      expect(seen).toEqual([[texts()[0], 6]])
      shown()
      const caret = renderer.getPaintedNodeSelection().caret!
      expect(caret.rect.x).toBeCloseTo(rect.x + 6 * COLUMN, 1)
    })

    it("at the end of a line, in the padding past it, goes to the line end", () => {
      const { host, texts, click, state } = mount(["short", "second"])
      host.focus()
      click([host.getBoundingClientRect().x + 30 * COLUMN, host.getBoundingClientRect().y + LINE / 2])
      expect(state()).toEqual([texts()[0], 5, texts()[0], 5])
    })

    it("in a host with no text puts the caret at the start of the host", () => {
      const root = createTestRoot({ width: 600, height: 400 })
      cleanups.push(() => root.unmount())
      root.render(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 300, height: 100 }} />
        </div>
      )
      const host = document.body!.querySelector("[contenteditable]") as HTMLElement
      const { click, state, at } = harness(root.renderer, host)
      click(at(1, 3))
      expect(document.activeElement).toBe(host)
      expect(state()).toEqual([host, 0, host, 0])
    })

    it("with Shift extends the focus and keeps the anchor, on either side of it", () => {
      const { host, texts, click, at, state } = mount(["hello world", "second line"])
      host.focus()
      click(at(0, 4))
      click(at(1, 3), 1, "shift")
      expect(state()).toEqual([texts()[0], 4, texts()[1], 3])
      click(at(0, 1), 1, "shift")
      expect(state()).toEqual([texts()[0], 4, texts()[0], 1])
    })

    it("with Shift extends from the caret that focus placed, and is a plain click when the selection is not in the host", () => {
      const { host, texts, click, at, state } = mount(["hello world"])
      click(at(0, 4), 1, "shift")
      expect(state()).toEqual([texts()[0], 4, texts()[0], 4])
      host.blur()
      document.getSelection().collapse(null)
      host.focus()
      document.getSelection().collapse(null)
      click(at(0, 6), 1, "shift")
      expect(state()).toEqual([texts()[0], 6, texts()[0], 6])
    })

    it("on text inside a contenteditable=false block lands at the nearest editable position outside it", () => {
      const root = createTestRoot({ width: 600, height: 400 })
      cleanups.push(() => root.unmount())
      root.render(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 400 }}>
            <div>first</div>
            <div contentEditable={false}>ISLAND</div>
            <div>last</div>
          </div>
        </div>
      )
      const host = document.body!.querySelector("[contenteditable]") as HTMLElement
      const { click, at, state } = harness(root.renderer, host)
      const [first, , last] = [...host.children].map((child) => child.firstChild as Text)
      click(at(1, 3))
      expect(state()[0]).toBe(first)
      expect(state()[1]).toBe(3)
      // Nearer to the last paragraph when the click is in the lower half of the island's row.
      const [x, y] = at(1, 2)
      click([x, y + LINE / 2 - 1])
      expect(state()).toEqual([last, 2, last, 2])
    })

    it("on text of an island inside a paragraph lands next to the island, on the side it is nearer", () => {
      const root = createTestRoot({ width: 600, height: 400 })
      cleanups.push(() => root.unmount())
      root.render(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 400 }}>
            <div>
              {"ab"}
              <span contentEditable={false}>{"WXYZ"}</span>
              {"cd"}
            </div>
          </div>
        </div>
      )
      const host = document.body!.querySelector("[contenteditable]") as HTMLElement
      const { click, at, state } = harness(root.renderer, host)
      const paragraph = host.firstElementChild as HTMLElement
      click(at(0, 3))
      expect(state()).toEqual([paragraph, 1, paragraph, 1])
      click(at(0, 5))
      expect(state()).toEqual([paragraph, 2, paragraph, 2])
    })

    it("on a button inside an island is the button's, and the selection stays", () => {
      const root = createTestRoot({ width: 600, height: 400 })
      cleanups.push(() => root.unmount())
      root.render(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 400 }}>
            <div>hello</div>
            <div contentEditable={false}>
              <button id="inside">press</button>
            </div>
          </div>
        </div>
      )
      const host = document.body!.querySelector("[contenteditable]") as HTMLElement
      const { click, at, state, texts } = harness(root.renderer, host)
      host.focus()
      document.getSelection().collapse(texts()[0]!, 2)
      click(at(1, 2))
      expect(document.activeElement).toBe(document.getElementById("inside"))
      expect(state()).toEqual([texts()[0], 2, texts()[0], 2])
    })
  })

  describe("a prevented press", () => {
    it("by mousedown changes nothing: no caret, no focus", () => {
      const { host, texts, click, at, state } = mount(["hello world", "second line"])
      host.addEventListener("mousedown", (event) => event.preventDefault())
      document.getSelection().collapse(texts()[1]!, 2)
      click(at(0, 4))
      expect(state()).toEqual([texts()[1], 2, texts()[1], 2])
      expect(document.activeElement).not.toBe(host)
    })

    it("by pointerdown still places the caret, as the selection is not the pointer events' default", () => {
      const { host, texts, click, at, state } = mount(["hello world"])
      let mousedowns = 0
      host.addEventListener("pointerdown", (event) => event.preventDefault())
      host.addEventListener("mousedown", () => mousedowns++)
      click(at(0, 4))
      expect(mousedowns).toBe(0)
      expect(state()).toEqual([texts()[0], 4, texts()[0], 4])
    })
  })

  describe("a drag", () => {
    it("across two paragraphs and a wrapped line selects exactly, and the wash follows", () => {
      const { texts, down, move, up, at, state, shown, renderer, rect } = wrapped()
      down(at(0, 2))
      move(at(1, 5))
      expect(state()).toEqual([texts()[0], 2, texts()[0], 15])
      move(at(2, 3))
      expect(state()).toEqual([texts()[0], 2, texts()[1], 3])
      up(at(2, 3))
      shown()
      const painted = renderer.getPaintedNodeSelection()
      expect(painted.caret).toBeUndefined()
      expect(painted.washes.map((wash) => [wash.start, wash.end, wash.rects.length])).toEqual([
        [2, 19, 2],
        [0, 3, 1],
      ])
      expect(painted.washes[0]!.rects[0]!.x).toBeCloseTo(rect.x + 2 * COLUMN, 1)
      expect(painted.washes[0]!.rects[1]!.y).toBeCloseTo(rect.y + LINE, 1)
      expect(painted.washes[1]!.rects[0]!.x).toBeCloseTo(rect.x, 1)
      expect(painted.washes[1]!.rects[0]!.width).toBeCloseTo(3 * COLUMN, 1)
      expect(renderer.getSelectedText(), "the painted selection stays out of a host").toBeNull()
    })

    it("backwards keeps the anchor and moves the focus before it", () => {
      const { texts, down, move, up, at, state } = wrapped()
      down(at(2, 3))
      move(at(0, 1))
      up(at(0, 1))
      expect(state()).toEqual([texts()[1], 3, texts()[0], 1])
    })

    it("outside the host clamps to the host", () => {
      const { texts, down, move, up, at, state } = wrapped()
      down(at(0, 2))
      move([590, 390])
      expect(state()).toEqual([texts()[0], 2, texts()[1], 5])
      move([0, 0])
      expect(state()).toEqual([texts()[0], 2, texts()[0], 0])
      up([0, 0])
      down(at(2, 3))
      move([0, 0])
      up([0, 0])
      expect(state()).toEqual([texts()[1], 3, texts()[0], 0])
    })

    it("ends at the release: a move after it changes nothing", () => {
      const { texts, down, move, up, at, state, renderer } = wrapped()
      down(at(0, 2))
      move(at(0, 6))
      up(at(0, 6))
      move(at(2, 3))
      expect(state()).toEqual([texts()[0], 2, texts()[0], 6])
      expect(renderer.getSelectedText()).toBeNull()
    })

    it("that began outside every host makes the painted selection, and never a node selection in the host", () => {
      const { host, renderer, state } = wrapped()
      host.focus()
      const outside = document.getElementById("outside")!.getBoundingClientRect()
      const selected = renderer.dragSelect(outside.x + 1, outside.y + LINE / 2, outside.x + outside.width + 40, outside.y + LINE / 2)
      expect(selected).toBe("outside text")
      renderer.dispatchNativeEvents()
      expect(state()[0], "the painted selection is not a range of nodes").toBeNull()
      expect(document.getSelection().toString()).toBe("outside text")
    })

    it("that began in a host and moved over the text outside it selects only inside the host", () => {
      const { texts, down, move, up, at, state, renderer } = wrapped()
      down(at(1, 4))
      const outside = document.getElementById("outside")!.getBoundingClientRect()
      move([outside.x + 20, outside.y + LINE / 2])
      up([outside.x + 20, outside.y + LINE / 2])
      expect(state()[0]).toBe(texts()[0])
      expect(renderer.getSelectedText()).toBeNull()
    })
  })

  describe("a double click", () => {
    it("selects the word under it", () => {
      const { texts, click, at, state, shown, renderer, rect } = mount(["hello brave world"])
      click(at(0, 8), 2)
      expect(state()).toEqual([texts()[0], 6, texts()[0], 11])
      shown()
      const wash = renderer.getPaintedNodeSelection().washes[0]!
      expect(wash.rects[0]!.x).toBeCloseTo(rect.x + 6 * COLUMN, 1)
    })

    it("at the end of a word selects that word and at a space the space", () => {
      const { texts, click, at, state } = mount(["hello brave world"])
      click(at(0, 5), 2)
      expect(state()).toEqual([texts()[0], 0, texts()[0], 5])
      click(at(0, 12), 2)
      expect(state()).toEqual([texts()[0], 12, texts()[0], 17])
      click(at(0, 17), 2)
      expect(state()).toEqual([texts()[0], 12, texts()[0], 17])
    })

    it("followed by a drag extends by words, and backwards keeps the word it began on", () => {
      const { texts, down, move, up, at, state } = mount(["hello brave world", "second line here"])
      down(at(0, 8))
      up(at(0, 8))
      down(at(0, 8), 2)
      expect(state()).toEqual([texts()[0], 6, texts()[0], 11])
      move(at(0, 14))
      expect(state()).toEqual([texts()[0], 6, texts()[0], 17])
      move(at(1, 3))
      expect(state()).toEqual([texts()[0], 6, texts()[1], 6])
      move(at(0, 1))
      expect(state()).toEqual([texts()[0], 11, texts()[0], 0])
      move(at(0, 8))
      expect(state()).toEqual([texts()[0], 6, texts()[0], 11])
      up(at(0, 8), 2)
      expect(state()).toEqual([texts()[0], 6, texts()[0], 11])
    })
  })

  describe("a triple click", () => {
    it("selects the contents of the paragraph", () => {
      const { host, texts, click, at, state, shown, renderer } = mount(["hello world", "second line"])
      click(at(1, 3), 3)
      const paragraph = host.children[1]!
      expect(state()).toEqual([paragraph, 0, paragraph, 1])
      expect(document.getSelection().toString()).toBe(texts()[1]!.data)
      shown()
      const washes = renderer.getPaintedNodeSelection().washes
      expect(washes.map((wash) => [wash.start, wash.end])).toEqual([[0, 11]])
    })

    it("followed by a drag extends by paragraphs, and backwards keeps the one it began on", () => {
      const root = createTestRoot({ width: 600, height: 400 })
      cleanups.push(() => root.unmount())
      root.render(
        <div style={{ padding: 20, ...TEXT }}>
          <div contentEditable style={{ width: 400 }}>
            <div>one</div>
            <div>two</div>
            <div>three</div>
          </div>
        </div>
      )
      const host = document.body!.querySelector("[contenteditable]") as HTMLElement
      const { down, move, up, at, state } = harness(root.renderer, host)
      const [one, two, three] = [...host.children]
      down(at(1, 1))
      up(at(1, 1))
      down(at(1, 1), 2)
      up(at(1, 1), 2)
      down(at(1, 1), 3)
      expect(state()).toEqual([two, 0, two, 1])
      move(at(2, 2))
      expect(state()).toEqual([two, 0, three, 1])
      move(at(0, 1))
      expect(state()).toEqual([two, 1, one, 0])
      up(at(0, 1), 3)
    })
  })

  describe("a click that is not in a host", () => {
    it("keeps today's painted selection, and a node selection in a host gives way to it", () => {
      const { host, texts, click, at, state, renderer } = mount(["hello world"])
      click(at(0, 4))
      expect(state()[0]).toBe(texts()[0])
      const outside = document.getElementById("outside")!.getBoundingClientRect()
      const selected = renderer.dragSelect(outside.x + 1, outside.y + LINE / 2, outside.x + outside.width + 40, outside.y + LINE / 2)
      expect(selected).toBe("outside text")
      renderer.dispatchNativeEvents()
      expect(state()[0]).toBeNull()
      expect(document.getSelection().toString()).toBe("outside text")
      expect(document.activeElement).not.toBe(host)
    })
  })
})
