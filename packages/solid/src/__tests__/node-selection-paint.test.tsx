/// The wash over a node selection inside an editing host, from the real paint pipeline: which text is
/// washed, and what a change of the selection costs a frame (a patch of the paragraphs it touches, not a frame
/// built whole). Menlo has one advance for every character, so a position is a column.
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

// Under the retention verifier a frame builds everything it compares, and with retention off nothing is skipped.
const counted = process.env.GPUIX_RETAIN_VERIFY === undefined && process.env.GPUIX_RETAIN_OFF === undefined

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

const COLUMN = measureColumn()

/** After the microtask in which the queue flushes a selection that changed outside a commit. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** A frame after the flush of a selection that changed outside a commit, and one more so that the frame after a change replays what it can. */
async function shown(renderer: { drawFrame(): void }): Promise<void> {
  await settle()
  renderer.drawFrame()
  renderer.drawFrame()
}

describe.skipIf(!hasNativeTestRenderer)("Solid: the wash of a node selection", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** An editing host with a paragraph for each line, in a box of a fixed size, which is what a patch frame lays out again. */
  function mount(lines: string[], width = 400) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    root.render(() => (
      <div style={{ padding: 20, ...TEXT }}>
        <div contentEditable style={{ width, height: 300 }}>
          {lines.map((line) => (
            <div>{line}</div>
          ))}
        </div>
      </div>
    ))
    const host = document.body!.querySelector("[contenteditable]") as HTMLElement
    const texts = [...host.children].map((child) => child.firstChild as Text)
    const renderer = root.renderer
    renderer.setA11yActive(false)
    renderer.setInlineDraws(false)
    return { host, texts, renderer, left: host.getBoundingClientRect().x, top: host.getBoundingClientRect().y }
  }

  describe("what is washed", () => {
    it("washes exactly the selected text across two paragraphs and a wrapped line", async () => {
      const { texts, renderer, left, top } = mount(["aaaa bbbb cccc dddd", "second line", "third"], 10 * COLUMN + 0.5)
      expect(renderer.getPaintedNodeSelection().washes).toEqual([])
      document.getSelection().setBaseAndExtent(texts[0]!, 5, texts[1]!, 6)
      await shown(renderer)
      const washes = renderer.getPaintedNodeSelection().washes
      expect(washes.map((wash) => [wash.start, wash.end])).toEqual([
        [5, 19],
        [0, 6],
      ])
      const [first, second] = washes as [(typeof washes)[number], (typeof washes)[number]]
      // `bbbb ` is the rest of the first row (its space hangs), `cccc dddd` the second row; the second paragraph is `second`.
      expect(first.rects).toHaveLength(2)
      expect(first.rects[0]!.x).toBeCloseTo(left + 5 * COLUMN, 1)
      expect(first.rects[0]!.width).toBeCloseTo(5 * COLUMN, 1)
      expect(first.rects[1]!.x).toBeCloseTo(left, 1)
      expect(first.rects[1]!.width).toBeCloseTo(9 * COLUMN, 1)
      expect(first.rects[1]!.y - first.rects[0]!.y).toBeCloseTo(LINE, 1)
      expect(first.rects[0]!.y).toBeCloseTo(top, 1)
      expect(second.rects).toHaveLength(1)
      expect(second.rects[0]!.x).toBeCloseTo(left, 1)
      expect(second.rects[0]!.width).toBeCloseTo(6 * COLUMN, 1)
      expect(second.rects[0]!.y).toBeCloseTo(top + 2 * LINE, 1)
      expect(second.rects[0]!.height).toBeCloseTo(LINE, 1)
    })

    it("washes the same text for a selection made backwards", async () => {
      const { texts, renderer } = mount(["first line", "second line"])
      document.getSelection().setBaseAndExtent(texts[1]!, 3, texts[0]!, 2)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end])).toEqual([
        [2, 10],
        [0, 3],
      ])
    })

    it("washes every paragraph whole for selectAllChildren of the host, and only the paragraphs between two element boundaries", async () => {
      const { host, renderer } = mount(["one", "two", "three", "four"])
      const selection = document.getSelection()
      selection.selectAllChildren(host)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end])).toEqual([
        [0, 3],
        [0, 3],
        [0, 5],
        [0, 4],
      ])
      selection.setBaseAndExtent(host, 1, host, 3)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end])).toEqual([
        [0, 3],
        [0, 5],
      ])
    })

    it("washes nothing for a caret, and nothing once the selection is collapsed", async () => {
      const { texts, renderer } = mount(["first line", "second line"])
      const selection = document.getSelection()
      selection.collapse(texts[0]!, 3)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes).toEqual([])
      selection.setBaseAndExtent(texts[0]!, 1, texts[1]!, 4)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes).toHaveLength(2)
      selection.collapse(texts[1]!, 4)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes).toEqual([])
      selection.setBaseAndExtent(texts[0]!, 1, texts[1]!, 4)
      await shown(renderer)
      selection.removeAllRanges()
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes).toEqual([])
    })

    it("follows an edit of the text it selects, in the same frame as the edit", async () => {
      const { host, texts, renderer } = mount(["first line", "second line"])
      document.getSelection().setBaseAndExtent(texts[0]!, 2, texts[1]!, 3)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end])).toEqual([
        [2, 10],
        [0, 3],
      ])
      ;(host.firstElementChild!.firstChild as Text).appendData(", longer")
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end])).toEqual([
        [2, 18],
        [0, 3],
      ])
    })

    it("washes a paragraph that is added inside the selection", async () => {
      const { host, texts, renderer } = mount(["first", "last"])
      document.getSelection().setBaseAndExtent(texts[0]!, 1, texts[1]!, 2)
      await shown(renderer)
      const added = document.createElement("div")
      added.textContent = "between"
      host.insertBefore(added, host.children[1]!)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end])).toEqual([
        [1, 5],
        [0, 7],
        [0, 2],
      ])
    })
  })

  describe("what a change costs", () => {
    const LINES = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"]

    /** What a frame built after `change`: how many roots retention skipped, and what it washed. */
    async function frame(renderer: ReturnType<typeof mount>["renderer"], change: () => void) {
      const before = renderer.getBuildCounters()
      change()
      await shown(renderer)
      const after = renderer.getBuildCounters()
      renderer.drawFrame()
      return {
        built: after.elementsBuilt - before.elementsBuilt,
        skipped: after.elementsSkipped - before.elementsSkipped,
        washed: renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end]),
      }
    }

    async function warm() {
      const mounted = mount(LINES)
      mounted.renderer.clockPause()
      for (let times = 0; times < 3; times++) mounted.renderer.drawFrame()
      document.getSelection().collapse(mounted.texts[0]!, 1)
      await settle()
      mounted.renderer.drawFrame()
      mounted.renderer.drawFrame()
      return mounted
    }

    // Skipped is counted in retained subtrees: a paragraph is a div and its text, so each paragraph that nothing marked is one skip.
    it("builds only the paragraphs a moved focus touches: the old and the new focus, not the one that keeps its anchor", async () => {
      const { texts, renderer } = await warm()
      const selection = document.getSelection()
      const first = await frame(renderer, () => selection.setBaseAndExtent(texts[1]!, 1, texts[2]!, 2))
      expect(first.washed).toEqual([
        [1, 4],
        [0, 2],
      ])
      // The focus moves on, from the third paragraph to the fourth: those two are built, the second (it keeps its anchor and its wash)
      // is not, and neither are the first, the fifth and the sixth.
      const moved = await frame(renderer, () => selection.setBaseAndExtent(texts[1]!, 1, texts[3]!, 2))
      expect(moved.washed).toEqual([
        [1, 4],
        [0, 4],
        [0, 2],
      ])
      if (counted) expect(moved.skipped, JSON.stringify(moved)).toBe(4)
    })

    it("builds one paragraph when the focus moves inside it", async () => {
      const { texts, renderer } = await warm()
      const selection = document.getSelection()
      await frame(renderer, () => selection.setBaseAndExtent(texts[1]!, 1, texts[3]!, 2))
      const inside = await frame(renderer, () => selection.setBaseAndExtent(texts[1]!, 1, texts[3]!, 3))
      expect(inside.washed).toEqual([
        [1, 4],
        [0, 4],
        [0, 3],
      ])
      if (counted) expect(inside.skipped, JSON.stringify(inside)).toBe(5)
      const further = await frame(renderer, () => selection.setBaseAndExtent(texts[1]!, 1, texts[3]!, 4))
      expect(further.washed.at(-1)).toEqual([0, 4])
      if (counted) expect(further.skipped, JSON.stringify(further)).toBe(5)
    })

    it("builds the paragraphs that lost their wash and the ones holding the ends when it is collapsed", async () => {
      const { texts, renderer } = await warm()
      const selection = document.getSelection()
      await frame(renderer, () => selection.setBaseAndExtent(texts[1]!, 1, texts[4]!, 2))
      const collapsed = await frame(renderer, () => selection.collapse(texts[4]!, 2))
      expect(collapsed.washed).toEqual([])
      // The second to the fifth; the first and the sixth are skipped.
      if (counted) expect(collapsed.skipped, JSON.stringify(collapsed)).toBe(2)
    })

    // Not a patch yet (docs/fork/editing.md, "Painting the node selection"): the wash adds and takes away quads, which a paint patch
    // cannot (`Operations`), and a patch of a root whose children retention skips counts fewer registrations than the recording
    // (`Registrations`), so gpui declines and the frame is built whole, through retention (the counts above).
    it.todo("a change of the selection is a patch frame, not a frame built whole")
  })

  describe("the painted selection", () => {
    it("still selects by dragging, and the two selections are exclusive", async () => {
      const root = createTestRoot({ width: 600, height: 400 })
      cleanups.push(() => root.unmount())
      root.render(() => (
        <div style={{ padding: 20, ...TEXT }}>
          <div style={{ width: 400 }}>outside the host</div>
          <div contentEditable style={{ width: 400, height: 100 }}>
            <div>inside the host</div>
          </div>
        </div>
      ))
      const renderer = root.renderer
      const selection = document.getSelection()
      const host = document.body!.querySelector("[contenteditable]") as HTMLElement
      const text = host.firstChild!.firstChild as Text
      selection.setBaseAndExtent(text, 2, text, 8)
      await shown(renderer)
      expect(renderer.getPaintedNodeSelection().washes).toHaveLength(1)
      expect(renderer.getSelectedText()).toBeNull()

      expect(renderer.dragSelect(21, 30, 500, 30)).toBe("outside the host")
      renderer.dispatchNativeEvents()
      await shown(renderer)
      expect(selection.type).toBe("Range")
      expect(selection.anchorNode).toBeNull()
      expect(renderer.getSelectedText()).toBe("outside the host")
      expect(renderer.getPaintedNodeSelection().washes).toEqual([])

      selection.setBaseAndExtent(text, 0, text, 6)
      await shown(renderer)
      expect(renderer.getSelectedText()).toBeNull()
      expect(renderer.getPaintedNodeSelection().washes.map((wash) => [wash.start, wash.end])).toEqual([[0, 6]])
    })
  })
})
