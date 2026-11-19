import { afterEach, beforeEach, describe, expect, it } from "vitest"
import "../dom-globals.js"
import { registerMutationQueue } from "../bounds.js"
import { takeNodeSelectionWrite } from "../editing/node-selection.js"
import { document } from "../events/window-target.js"
import { createRendererState } from "../renderer-state.js"
import { asNode, el, scriptedWindow, tx, type FakeEl, type ScriptedWindow } from "./fixtures/painted-dom.js"

const n = asNode

/** A queue that only counts the flushes it is asked for. */
function fakeQueue(renderer: object): { flushes: number } {
  const queue = {
    flushes: 0,
    flushMutations() {},
    requestFlush() {
      queue.flushes++
    },
  }
  registerMutationQueue(renderer, queue)
  return queue
}

describe("sending the selection of nodes to native", () => {
  const selection = document.getSelection()
  const cleanups: Array<() => void> = []
  let one: ScriptedWindow
  let two: ScriptedWindow

  beforeEach(() => {
    one = scriptedWindow()
    two = scriptedWindow()
    for (const window of [one, two]) cleanups.push(createRendererState(window.renderer).attach({ onSelectionChange: undefined }).detach)
  })

  afterEach(() => {
    selection.collapse(null)
    // The clear the collapse asked for is taken, as the flush of a queue would.
    takeNodeSelectionWrite(one.renderer)
    takeNodeSelectionWrite(two.renderer)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function paragraphs(window: ScriptedWindow, ...lines: string[]): { host: FakeEl; texts: ReturnType<typeof tx>[] } {
    const texts = lines.map((line) => tx(window, line))
    const host = el(window, "div", ...texts.map((text) => el(window, "p", text)))
    host.props.contenteditable = "true"
    return { host, texts }
  }

  it("sends the two boundary points the selection holds, once, and nothing while it is unchanged", () => {
    const { texts } = paragraphs(one, "first", "second")
    expect(takeNodeSelectionWrite(one.renderer)).toBeUndefined()
    selection.setBaseAndExtent(n(texts[0]!), 1, n(texts[1]!), 4)
    expect(takeNodeSelectionWrite(one.renderer)).toEqual({
      anchorId: texts[0]!.id,
      anchorOffset: 1,
      focusId: texts[1]!.id,
      focusOffset: 4,
      hostId: 0,
    })
    expect(takeNodeSelectionWrite(one.renderer)).toBeUndefined()
    expect(takeNodeSelectionWrite(two.renderer)).toBeUndefined()
  })

  it("keeps the direction, and sends an element boundary as the element and a child index", () => {
    const { host, texts } = paragraphs(one, "first", "second")
    selection.setBaseAndExtent(n(texts[1]!), 2, n(host), 0)
    expect(takeNodeSelectionWrite(one.renderer)).toEqual({
      anchorId: texts[1]!.id,
      anchorOffset: 2,
      focusId: host.id,
      focusOffset: 0,
      hostId: 0,
    })
  })

  it("names the editing host while the selection is collapsed in it, and not when it is a range", () => {
    const { host, texts } = paragraphs(one, "first", "second")
    selection.collapse(n(texts[0]!), 2)
    expect(takeNodeSelectionWrite(one.renderer)).toMatchObject({ hostId: host.id })
    selection.setBaseAndExtent(n(texts[0]!), 2, n(texts[0]!), 4)
    expect(takeNodeSelectionWrite(one.renderer)).toMatchObject({ hostId: 0 })
  })

  it("asks the queue of the root for a flush when the selection changes, and for the root it left", () => {
    const first = paragraphs(one, "first").texts[0]!
    const second = paragraphs(two, "second").texts[0]!
    const queues = [fakeQueue(one.renderer), fakeQueue(two.renderer)]
    selection.collapse(n(first), 1)
    expect(queues.map((queue) => queue.flushes)).toEqual([1, 0])
    takeNodeSelectionWrite(one.renderer)
    selection.collapse(n(second), 1)
    expect(queues.map((queue) => queue.flushes)).toEqual([2, 1])
  })

  it("moves with the selection between two roots: the new one is sent it and the old one is cleared", () => {
    const first = paragraphs(one, "first").texts[0]!
    const second = paragraphs(two, "second").texts[0]!
    selection.collapse(n(first), 1)
    expect(takeNodeSelectionWrite(one.renderer)).toMatchObject({ anchorId: first.id })
    selection.collapse(n(second), 3)
    expect(takeNodeSelectionWrite(two.renderer)).toMatchObject({ anchorId: second.id, anchorOffset: 3 })
    expect(takeNodeSelectionWrite(one.renderer)).toBeNull()
    expect(takeNodeSelectionWrite(one.renderer)).toBeUndefined()
  })

  it("clears the root when the selection is removed, and sends a selection that is changed back", () => {
    const first = paragraphs(one, "first").texts[0]!
    selection.collapse(n(first), 1)
    takeNodeSelectionWrite(one.renderer)
    selection.removeAllRanges()
    expect(takeNodeSelectionWrite(one.renderer)).toBeNull()
    selection.collapse(n(first), 1)
    expect(takeNodeSelectionWrite(one.renderer)).toMatchObject({ anchorId: first.id })
  })

  it("follows a boundary that a change to the tree moves", () => {
    const { texts } = paragraphs(one, "abcdef")
    selection.collapse(n(texts[0]!), 4)
    takeNodeSelectionWrite(one.renderer)
    selection.getRangeAt(0).setStart(n(texts[0]!), 2)
    expect(takeNodeSelectionWrite(one.renderer)).toMatchObject({ anchorOffset: 2, focusOffset: 4 })
  })
})
