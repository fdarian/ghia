/**
 * An `itemCount` change on a windowed `<virtual-list>`: a count that shrinks drops the tail rows
 * of the list state it has, so the heights it measured, its scroll anchor and its focus handles
 * stay; a count that grows rebuilds the state (`list_resize.rs` says why).
 */

import { describe, expect, it } from "vitest"
import type { PublicInstance } from "../types/host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

const ROW = 36
const WINDOW = 60

interface Page {
  count: number
  start: number
  /** Rows mounted; the window of `WINDOW` rows, cut by the count, when not given. */
  rows?: number
  label?: string
  followTail?: boolean
  inputAt?: number
}

let instance: PublicInstance | null = null

function page(props: Page) {
  const rows = props.rows ?? Math.min(WINDOW, Math.max(0, props.count - props.start))
  return (
    <div style={{ width: 400, height: 340, flexDirection: "column" }}>
      <div>{props.label ?? "label"}</div>
      <virtual-list
        ref={(handle: PublicInstance | null) => {
          instance = handle
        }}
        itemCount={props.count}
        windowStart={props.start}
        estimatedItemHeight={ROW}
        followTail={props.followTail}
        style={{ width: 400, height: 300 }}
      >
        {Array.from({ length: rows }, (_, offset) => (
          <div key={props.start + offset} style={{ height: ROW, flexShrink: 0 }}>
            {props.start + offset === props.inputAt ? (
              <input autoFocus defaultValue="x" />
            ) : (
              <div>{`row-${props.start + offset}`}</div>
            )}
          </div>
        ))}
      </virtual-list>
    </div>
  )
}

function mount(props: Page) {
  const root = createTestRoot({ width: 400, height: 340 })
  root.renderer.setInlineDraws(false)
  root.render(page(props))
  root.renderer.drawFrame()
  const { renderer } = root
  const id = renderer.findByType("virtual-list")[0].id
  return {
    renderer,
    id,
    get target(): PublicInstance {
      if (instance === null) throw new Error("the list is not mounted")
      return instance
    },
    top: () => renderer.getListScrollTop(id),
    show(next: Page) {
      root.render(page(next))
      renderer.drawFrame()
    },
    /** The work one change of the page did. */
    work(next: Page) {
      renderer.resetBuildCounters()
      const before = renderer.getLayoutCounters()
      this.show(next)
      const after = renderer.getLayoutCounters()
      const built = renderer.getBuildCounters()
      return {
        measures: after.measures - before.measures,
        nodesCreated: after.nodesCreated - before.nodesCreated,
        listStatesCreated: built.listStatesCreated,
        listItemsSpliced: built.listItemsSpliced,
      }
    },
  }
}

/** A list scrolled to row 100 with its window around it. */
function scrolled(count: number) {
  const list = mount({ count, start: 0 })
  list.renderer.scrollToItem(list.id, 100)
  list.show({ count, start: 90 })
  expect(list.top()).toEqual([100, 0, 300])
  return list
}

describeNative("itemCount changes on a windowed list", () => {
  it("drops the tail of the list state on a shrink and measures nothing again", () => {
    const list = scrolled(10_000)
    const control = list.work({ count: 10_000, start: 90, label: "other" })
    expect(control.listStatesCreated).toBe(0)

    let spliced = 0
    for (let count = 9_999; count >= 9_990; count--) {
      const work = list.work({ count, start: 90 })
      expect(work.listStatesCreated, `count ${count}`).toBe(0)
      expect(work.measures, `count ${count}`).toBeLessThanOrEqual(control.measures)
      expect(work.nodesCreated, `count ${count}`).toBeLessThanOrEqual(control.nodesCreated)
      spliced += work.listItemsSpliced
    }
    expect(spliced).toBe(10)
    expect(list.top()).toEqual([100, 0, 300])
    expect(list.target.scrollHeight).toBe(9_990 * ROW)
  })

  it("splices as many items as the count dropped by, whatever the count", () => {
    const spliced = [1_000, 100_000].map((count) => {
      const list = scrolled(count)
      return list.work({ count: count - 3, start: 90 }).listItemsSpliced
    })
    expect(spliced).toEqual([3, 3])
  })

  it("rebuilds the state on a grow, with the scroll position and the estimated length", () => {
    const list = scrolled(9_990)
    const work = list.work({ count: 10_000, start: 90 })
    expect(work.listStatesCreated).toBe(1)
    expect(work.listItemsSpliced).toBe(0)
    expect(list.top()).toEqual([100, 0, 300])
    expect(list.target.scrollHeight).toBe(10_000 * ROW)
  })

  it("rebuilds on a change of any other setting", () => {
    const list = scrolled(10_000)
    const work = list.work({ count: 10_000, start: 90, followTail: true })
    expect(work.listStatesCreated).toBe(1)
  })

  it("clamps a scroll position the shrink removed, with the window still past the count", () => {
    const list = mount({ count: 10_000, start: 0 })
    list.renderer.scrollToItem(list.id, 5_000)
    list.show({ count: 10_000, start: 4_990 })
    expect(list.top()?.[0]).toBe(5_000)

    list.show({ count: 100, start: 4_990, rows: WINDOW })
    expect(list.target.scrollHeight).toBe(100 * ROW)
    expect(list.target.scrollTop).toBe(100 * ROW - 300)

    list.show({ count: 100, start: 40 })
    expect(list.target.scrollTop).toBe(100 * ROW - 300)
    expect(list.renderer.getPaintedText()).toContain("row-99")
  })

  it("keeps a list that follows its tail following, whichever way the count goes", () => {
    const list = mount({ count: 200, start: 140, followTail: true })
    const atEnd = () => list.target.scrollTop === list.target.scrollHeight - list.target.clientHeight
    expect(atEnd()).toBe(true)

    list.show({ count: 190, start: 130, followTail: true })
    expect(atEnd()).toBe(true)
    expect(list.renderer.getPaintedText()).toContain("row-189")

    list.show({ count: 250, start: 190, followTail: true })
    expect(atEnd()).toBe(true)
    expect(list.renderer.getPaintedText()).toContain("row-249")
  })

  it("survives a shrink past a focused row and a row that turns focusable past the count", () => {
    const list = mount({ count: 10_000, start: 0 })
    list.renderer.scrollToItem(list.id, 9_990)
    list.show({ count: 10_000, start: 9_940, inputAt: 9_995 })

    list.show({ count: 9_990, start: 9_940, rows: WINDOW, inputAt: 9_995 })
    list.show({ count: 9_990, start: 9_940, rows: WINDOW, inputAt: 9_996 })
    expect(list.target.scrollHeight).toBe(9_990 * ROW)

    list.show({ count: 9_990, start: 9_930 })
    expect(list.renderer.getPaintedText()).toContain("row-9989")
    expect(list.target.scrollHeight).toBe(9_990 * ROW)
  })
})
