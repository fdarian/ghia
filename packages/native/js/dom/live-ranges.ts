/**
 * The live ranges of the document and the steps the DOM standard runs on them when a tree changes:
 * "live range pre-remove steps", the range steps of "insert", "replace data" and "split a Text node".
 * An adapter calls them at the place where it changes a node's children, and `CharacterData` calls
 * them where it changes a node's data, so a `Range` keeps pointing at what it pointed at, as in a
 * browser.
 *
 * Every hook returns at once while no range exists (`hasLiveRanges()`), so a page that never makes
 * a `Range` pays a counter check per tree change. A range is held weakly: one that nothing refers
 * to is collected and stops being adjusted.
 *
 * This module reads nodes only through their public members and imports nothing at run time, so
 * `nodes.ts` and the adapters can call it.
 */

import type { Node } from "./nodes.js"

/** What a `Range` is: two boundary points, which the steps below move. */
export type RangeBoundaries = {
  startNode: Node
  startOffset: number
  endNode: Node
  endOffset: number
  /**
   * Called after a tree or data change moved a boundary point of this range, so its owner (the
   * `Selection`) can tell. A range's own methods do not call it.
   */
  onAdjust?: () => void
}

type Held = { set: Set<WeakRef<RangeBoundaries>>; ref: WeakRef<RangeBoundaries> }

type Registry = {
  ranges: Set<WeakRef<RangeBoundaries>>
  count: number
  collected: FinalizationRegistry<Held>
}

const KEY = Symbol.for("@ghia/native/live-ranges")

/** On `globalThis` like the DOM classes: a second copy of this package must adjust the ranges the first one made. */
const registry: Registry = (() => {
  const existing = Reflect.get(globalThis, KEY) as Registry | undefined
  if (existing) return existing
  const created: Registry = {
    ranges: new Set(),
    count: 0,
    collected: new FinalizationRegistry((held) => {
      if (held.set.delete(held.ref)) created.count -= 1
    }),
  }
  Reflect.set(globalThis, KEY, created)
  return created
})()

export function hasLiveRanges(): boolean {
  return registry.count > 0
}

export function registerLiveRange(boundaries: RangeBoundaries): void {
  const ref = new WeakRef(boundaries)
  registry.ranges.add(ref)
  registry.count += 1
  registry.collected.register(boundaries, { set: registry.ranges, ref })
}

function forEachRange(visit: (range: RangeBoundaries) => void): void {
  for (const ref of registry.ranges) {
    const range = ref.deref()
    if (range === undefined) {
      if (registry.ranges.delete(ref)) registry.count -= 1
      continue
    }
    const startNode = range.startNode
    const startOffset = range.startOffset
    const endNode = range.endNode
    const endOffset = range.endOffset
    visit(range)
    if (
      range.onAdjust !== undefined &&
      (range.startNode !== startNode ||
        range.startOffset !== startOffset ||
        range.endNode !== endNode ||
        range.endOffset !== endOffset)
    ) {
      range.onAdjust()
    }
  }
}

function isInclusiveDescendant(node: Node, ancestor: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

/** Call before `child`, the child of `parent` at `index`, is taken out of it. */
export function liveRangesBeforeRemove(parent: Node, child: Node, index: number): void {
  if (registry.count === 0) return
  forEachRange((range) => {
    if (isInclusiveDescendant(range.startNode, child)) {
      range.startNode = parent
      range.startOffset = index
    }
    if (isInclusiveDescendant(range.endNode, child)) {
      range.endNode = parent
      range.endOffset = index
    }
    if (range.startNode === parent && range.startOffset > index) range.startOffset -= 1
    if (range.endNode === parent && range.endOffset > index) range.endOffset -= 1
  })
}

/** Call once `count` nodes were placed in `parent` from `index` on. */
export function liveRangesAfterInsert(parent: Node, index: number, count: number): void {
  if (registry.count === 0) return
  forEachRange((range) => {
    if (range.startNode === parent && range.startOffset > index) range.startOffset += count
    if (range.endNode === parent && range.endOffset > index) range.endOffset += count
  })
}

/** Call when `count` code units of `node` from `offset` are replaced by `addedLength` of them. */
export function liveRangesReplaceData(node: Node, offset: number, count: number, addedLength: number): void {
  if (registry.count === 0) return
  forEachRange((range) => {
    if (range.startNode === node) {
      if (range.startOffset > offset && range.startOffset <= offset + count) range.startOffset = offset
      else if (range.startOffset > offset + count) range.startOffset += addedLength - count
    }
    if (range.endNode === node) {
      if (range.endOffset > offset && range.endOffset <= offset + count) range.endOffset = offset
      else if (range.endOffset > offset + count) range.endOffset += addedLength - count
    }
  })
}

/**
 * Call after `created`, the second half of `node` cut at `offset`, was inserted after `node` in
 * `parent`: the range steps of "split a Text node" that follow the insert, before the data is cut.
 * `parent` is `node`'s parent, `indexOfNode` the index of `node` in it.
 */
export function liveRangesSplitText(node: Node, offset: number, created: Node, parent: Node, indexOfNode: number): void {
  if (registry.count === 0) return
  forEachRange((range) => {
    if (range.startNode === node && range.startOffset > offset) {
      range.startNode = created
      range.startOffset -= offset
    }
    if (range.endNode === node && range.endOffset > offset) {
      range.endNode = created
      range.endOffset -= offset
    }
    if (range.startNode === parent && range.startOffset === indexOfNode + 1) range.startOffset += 1
    if (range.endNode === parent && range.endOffset === indexOfNode + 1) range.endOffset += 1
  })
}
