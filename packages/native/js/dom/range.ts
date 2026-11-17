/**
 * `AbstractRange`, `StaticRange` and `Range`, written from the DOM standard's "Ranges" chapter.
 * A `Range` is live: `live-ranges.ts` moves its boundary points when the tree or a node's data
 * changes. A `StaticRange` is a plain pair of boundary points.
 *
 * `createContextualFragment` and `expand` are not here. The rects of `getBoundingClientRect` and
 * `getClientRects` are in `range-geometry.ts`.
 */

import { namedError } from "../named-error.js"
import { DOMRectList, DOMRect } from "./dom-rect.js"
import { rangeBoundingClientRect, rangeClientRects } from "./range-geometry.js"
import { registerLiveRange, type RangeBoundaries } from "./live-ranges.js"
import {
  CharacterData,
  DOM_BINDING,
  Node,
  runtimeDocument,
  type DocumentFragment,
  type ParentBinding,
  type Text,
  type TextBinding,
} from "./nodes.js"
import { cloneNode } from "./clone.js"
import { comparePoints, indexOfNode, isInclusiveAncestor, nodeLength, rootOf } from "./tree-order.js"
import { assertCanInsert, replaceChildren } from "./tree-mutation.js"

const TEXT_NODE = 3
const DOCUMENT_NODE = 9
const DOCUMENT_FRAGMENT_NODE = 11

const START_TO_START = 0
const START_TO_END = 1
const END_TO_END = 2
const END_TO_START = 3

/** Where `AbstractRange` reads the boundary points of whichever range it is. */
const BOUNDS: unique symbol = Symbol.for("@ghia/native/range-boundaries")

function indexSizeError(): DOMException {
  return namedError("IndexSizeError", "The offset is larger than the node's length") as DOMException
}

function invalidNodeTypeError(message: string): DOMException {
  return namedError("InvalidNodeTypeError", message) as DOMException
}

function wrongDocumentError(): DOMException {
  return namedError("WrongDocumentError", "The two ranges are not in the same tree") as DOMException
}

function assertNode(value: unknown, method: string, owner: string): asserts value is Node {
  if (!(value instanceof Node)) {
    throw new TypeError(`Failed to execute '${method}' on '${owner}': parameter 1 is not of type 'Node'.`)
  }
}

function startPosition(bounds: RangeBoundaries, node: Node, offset: number): -1 | 0 | 1 {
  return comparePoints(node, offset, bounds.startNode, bounds.startOffset)
}

function endPosition(bounds: RangeBoundaries, node: Node, offset: number): -1 | 0 | 1 {
  return comparePoints(node, offset, bounds.endNode, bounds.endOffset)
}

/** "Contained": the node is in the range's tree and lies wholly between its two boundary points. */
function isContained(bounds: RangeBoundaries, node: Node): boolean {
  return (
    rootOf(node) === rootOf(bounds.startNode) &&
    startPosition(bounds, node, 0) === 1 &&
    endPosition(bounds, node, nodeLength(node)) === -1
  )
}

function isPartiallyContained(bounds: RangeBoundaries, node: Node): boolean {
  return isInclusiveAncestor(node, bounds.startNode) !== isInclusiveAncestor(node, bounds.endNode)
}

function commonAncestor(bounds: RangeBoundaries): Node {
  let container = bounds.startNode
  while (!isInclusiveAncestor(container, bounds.endNode)) {
    const parent = container.parentNode
    if (parent === null) throw new Error("The two ends of the range have no common ancestor")
    container = parent
  }
  return container
}

/** The contained nodes whose parent is not contained, in tree order: what "extract" and "delete" take out. */
function topmostContainedNodes(bounds: RangeBoundaries): Node[] {
  const found: Node[] = []
  const visit = (parent: Node): void => {
    for (const child of parent[DOM_BINDING]().children) {
      if (isContained(bounds, child)) found.push(child)
      else if (isInclusiveAncestor(child, bounds.startNode) || isInclusiveAncestor(child, bounds.endNode)) visit(child)
    }
  }
  visit(commonAncestor(bounds))
  return found
}

function appendContainedText(node: Node, into: string[]): void {
  if (node.nodeType === TEXT_NODE) {
    into.push((node as Text).data)
    return
  }
  for (const child of node[DOM_BINDING]().children) appendContainedText(child, into)
}

/** An empty fragment of the window `node` belongs to; the document's, which has no window of its own, for a node that is not in one. */
export function createFragmentFor(node: Node): DocumentFragment {
  const binding = node[DOM_BINDING]() as Partial<ParentBinding & TextBinding>
  if (binding.createFragment !== undefined) return binding.createFragment()
  return (runtimeDocument() as unknown as { createDocumentFragment(): DocumentFragment }).createDocumentFragment()
}

/** A Text node of the window `node` belongs to, holding `data`, in no tree yet. */
export function createTextFor(node: Node, data: string): Text {
  const binding = node[DOM_BINDING]() as Partial<ParentBinding & TextBinding>
  if (binding.createText !== undefined) return binding.createText(data)
  return (runtimeDocument() as unknown as { createTextNode(data: string): Text }).createTextNode(data)
}

/** The children of the common ancestor that hold one end of the range but not the other. */
function partiallyContainedChildren(bounds: RangeBoundaries): { first: Node | null; last: Node | null } {
  const ancestor = commonAncestor(bounds)
  const children = ancestor[DOM_BINDING]().children
  const first = isInclusiveAncestor(bounds.startNode, bounds.endNode)
    ? null
    : (children.find((child) => isPartiallyContained(bounds, child)) ?? null)
  let last: Node | null = null
  if (!isInclusiveAncestor(bounds.endNode, bounds.startNode)) {
    for (let index = children.length - 1; index >= 0 && last === null; index -= 1) {
      if (isPartiallyContained(bounds, children[index])) last = children[index]
    }
  }
  return { first, last }
}

/** Whether an element lies across a boundary of the range, which `surroundContents` cannot wrap. */
function partiallyContainsNonText(bounds: RangeBoundaries): boolean {
  const ancestor = commonAncestor(bounds)
  for (const end of [bounds.startNode, bounds.endNode]) {
    for (let node: Node | null = end; node !== null && node !== ancestor; node = node.parentNode) {
      if (node.nodeType !== TEXT_NODE) return true
    }
  }
  return false
}

function containedChildren(bounds: RangeBoundaries): Node[] {
  return commonAncestor(bounds)[DOM_BINDING]().children.filter((child) => isContained(bounds, child))
}

function boundsOf(startNode: Node, startOffset: number, endNode: Node, endOffset: number): RangeBoundaries {
  return { startNode, startOffset, endNode, endOffset }
}

/** A clone of the character data node with only `data` as its text; for the ends of a cloned or extracted range. */
function cloneCharacterData(node: Node, offset: number, count: number): Node {
  const clone = cloneNode(node, false) as CharacterData
  clone.data = (node as CharacterData).substringData(offset, count)
  return clone
}

/** "Clone the contents of a range": a fragment of copies of what the range covers, the tree untouched. */
function cloneContentsOf(bounds: RangeBoundaries): DocumentFragment {
  const fragment = createFragmentFor(bounds.startNode)
  if (bounds.startNode === bounds.endNode && bounds.startOffset === bounds.endOffset) return fragment
  const startNode = bounds.startNode
  const startOffset = bounds.startOffset
  const endNode = bounds.endNode
  const endOffset = bounds.endOffset
  if (startNode === endNode && startNode instanceof CharacterData) {
    fragment.appendChild(cloneCharacterData(startNode, startOffset, endOffset - startOffset))
    return fragment
  }
  const partial = partiallyContainedChildren(bounds)
  const first = partial.first
  const last = partial.last
  const contained = containedChildren(bounds)
  if (first instanceof CharacterData) {
    fragment.appendChild(cloneCharacterData(startNode, startOffset, first.data.length - startOffset))
  } else if (first !== null) {
    const clone = cloneNode(first, false)
    fragment.appendChild(clone)
    clone.appendChild(cloneContentsOf(boundsOf(startNode, startOffset, first, nodeLength(first))))
  }
  for (const child of contained) fragment.appendChild(cloneNode(child, true))
  if (last instanceof CharacterData) {
    fragment.appendChild(cloneCharacterData(last, 0, endOffset))
  } else if (last !== null) {
    const clone = cloneNode(last, false)
    fragment.appendChild(clone)
    clone.appendChild(cloneContentsOf(boundsOf(last, 0, endNode, endOffset)))
  }
  return fragment
}

/**
 * "Extract a live range": what the range covers moves into the returned fragment, with copies of
 * the partly covered ends, and the range collapses where the standard says. The sub-ranges the
 * partly covered children take are plain boundary points: nothing reads them after their own
 * extraction has started.
 */
function extractContentsOf(bounds: RangeBoundaries): DocumentFragment {
  const fragment = createFragmentFor(bounds.startNode)
  if (bounds.startNode === bounds.endNode && bounds.startOffset === bounds.endOffset) return fragment
  const startNode = bounds.startNode
  const startOffset = bounds.startOffset
  const endNode = bounds.endNode
  const endOffset = bounds.endOffset
  if (startNode === endNode && startNode instanceof CharacterData) {
    fragment.appendChild(cloneCharacterData(startNode, startOffset, endOffset - startOffset))
    startNode.replaceData(startOffset, endOffset - startOffset, "")
    return fragment
  }
  const partial = partiallyContainedChildren(bounds)
  const first = partial.first
  const last = partial.last
  const contained = containedChildren(bounds)
  let newNode: Node
  let newOffset: number
  if (isInclusiveAncestor(startNode, endNode)) {
    newNode = startNode
    newOffset = startOffset
  } else {
    let reference = startNode
    for (let parent = reference.parentNode; parent !== null && !isInclusiveAncestor(parent, endNode); parent = reference.parentNode) {
      reference = parent
    }
    newNode = parentOrThrow(reference)
    newOffset = indexOfNode(reference) + 1
  }
  if (first instanceof CharacterData) {
    const count = first.data.length - startOffset
    fragment.appendChild(cloneCharacterData(first, startOffset, count))
    first.replaceData(startOffset, count, "")
  } else if (first !== null) {
    const clone = cloneNode(first, false)
    fragment.appendChild(clone)
    clone.appendChild(extractContentsOf(boundsOf(startNode, startOffset, first, nodeLength(first))))
  }
  for (const child of contained) fragment.appendChild(child)
  if (last instanceof CharacterData) {
    fragment.appendChild(cloneCharacterData(last, 0, endOffset))
    last.replaceData(0, endOffset, "")
  } else if (last !== null) {
    const clone = cloneNode(last, false)
    fragment.appendChild(clone)
    clone.appendChild(extractContentsOf(boundsOf(last, 0, endNode, endOffset)))
  }
  bounds.startNode = newNode
  bounds.startOffset = newOffset
  bounds.endNode = newNode
  bounds.endOffset = newOffset
  return fragment
}

function setBoundary(bounds: RangeBoundaries, node: Node, offset: number, isStart: boolean): void {
  if (offset > nodeLength(node)) throw indexSizeError()
  const differentRoot = rootOf(bounds.startNode) !== rootOf(node)
  if (isStart) {
    if (differentRoot || endPosition(bounds, node, offset) === 1) {
      bounds.endNode = node
      bounds.endOffset = offset
    }
    bounds.startNode = node
    bounds.startOffset = offset
  } else {
    if (differentRoot || startPosition(bounds, node, offset) === -1) {
      bounds.startNode = node
      bounds.startOffset = offset
    }
    bounds.endNode = node
    bounds.endOffset = offset
  }
}

function parentOrThrow(node: Node): Node {
  const parent = node.parentNode
  if (parent === null) throw invalidNodeTypeError("The node has no parent")
  return parent
}

function assertSameRoot(bounds: RangeBoundaries, node: Node): void {
  if (rootOf(bounds.startNode) !== rootOf(node)) throw wrongDocumentError()
}

abstract class AbstractRangeClass {
  constructor() {
    if (new.target === AbstractRangeClass) throw new TypeError("Illegal constructor")
  }

  abstract [BOUNDS](): RangeBoundaries

  get startContainer(): Node {
    return this[BOUNDS]().startNode
  }

  get startOffset(): number {
    return this[BOUNDS]().startOffset
  }

  get endContainer(): Node {
    return this[BOUNDS]().endNode
  }

  get endOffset(): number {
    return this[BOUNDS]().endOffset
  }

  get collapsed(): boolean {
    const bounds = this[BOUNDS]()
    return bounds.startNode === bounds.endNode && bounds.startOffset === bounds.endOffset
  }
}

export interface StaticRangeInit {
  startContainer: Node
  startOffset: number
  endContainer: Node
  endOffset: number
}

class StaticRangeClass extends AbstractRangeClass {
  readonly #bounds: RangeBoundaries

  constructor(init: StaticRangeInit) {
    super()
    if (init === null || typeof init !== "object") {
      throw new TypeError("Failed to construct 'StaticRange': parameter 1 is not of type 'StaticRangeInit'.")
    }
    for (const name of ["startContainer", "endContainer"] as const) {
      if (!(init[name] instanceof Node)) {
        throw new TypeError(`Failed to construct 'StaticRange': required member ${name} is not of type 'Node'.`)
      }
    }
    for (const name of ["startOffset", "endOffset"] as const) {
      if (init[name] === undefined) {
        throw new TypeError(`Failed to construct 'StaticRange': required member ${name} is undefined.`)
      }
    }
    this.#bounds = {
      startNode: init.startContainer,
      startOffset: init.startOffset >>> 0,
      endNode: init.endContainer,
      endOffset: init.endOffset >>> 0,
    }
  }

  [BOUNDS](): RangeBoundaries {
    return this.#bounds
  }
}

class RangeClass extends AbstractRangeClass {
  static readonly START_TO_START = START_TO_START
  static readonly START_TO_END = START_TO_END
  static readonly END_TO_END = END_TO_END
  static readonly END_TO_START = END_TO_START

  declare readonly START_TO_START: 0
  declare readonly START_TO_END: 1
  declare readonly END_TO_END: 2
  declare readonly END_TO_START: 3

  readonly #bounds: RangeBoundaries

  constructor() {
    super()
    const document = runtimeDocument() as unknown as Node
    this.#bounds = { startNode: document, startOffset: 0, endNode: document, endOffset: 0 }
    registerLiveRange(this.#bounds)
  }

  [BOUNDS](): RangeBoundaries {
    return this.#bounds
  }

  get commonAncestorContainer(): Node {
    return commonAncestor(this.#bounds)
  }

  /**
   * Runs one of the range's own changes, then tells the `Selection` holding this range (`onAdjust`)
   * if it moved a boundary point, as a tree change does: a range the selection holds is the selection.
   */
  #changing<T>(change: () => T): T {
    const bounds = this.#bounds
    if (bounds.onAdjust === undefined) return change()
    const startNode = bounds.startNode
    const startOffset = bounds.startOffset
    const endNode = bounds.endNode
    const endOffset = bounds.endOffset
    try {
      return change()
    } finally {
      if (
        bounds.startNode !== startNode ||
        bounds.startOffset !== startOffset ||
        bounds.endNode !== endNode ||
        bounds.endOffset !== endOffset
      ) {
        bounds.onAdjust?.()
      }
    }
  }

  setStart(node: Node, offset: number): void {
    assertNode(node, "setStart", "Range")
    this.#changing(() => setBoundary(this.#bounds, node, offset >>> 0, true))
  }

  setEnd(node: Node, offset: number): void {
    assertNode(node, "setEnd", "Range")
    this.#changing(() => setBoundary(this.#bounds, node, offset >>> 0, false))
  }

  setStartBefore(node: Node): void {
    assertNode(node, "setStartBefore", "Range")
    this.#changing(() => setBoundary(this.#bounds, parentOrThrow(node), indexOfNode(node), true))
  }

  setStartAfter(node: Node): void {
    assertNode(node, "setStartAfter", "Range")
    this.#changing(() => setBoundary(this.#bounds, parentOrThrow(node), indexOfNode(node) + 1, true))
  }

  setEndBefore(node: Node): void {
    assertNode(node, "setEndBefore", "Range")
    this.#changing(() => setBoundary(this.#bounds, parentOrThrow(node), indexOfNode(node), false))
  }

  setEndAfter(node: Node): void {
    assertNode(node, "setEndAfter", "Range")
    this.#changing(() => setBoundary(this.#bounds, parentOrThrow(node), indexOfNode(node) + 1, false))
  }

  collapse(toStart: boolean = false): void {
    const bounds = this.#bounds
    this.#changing(() => {
      if (toStart) {
        bounds.endNode = bounds.startNode
        bounds.endOffset = bounds.startOffset
      } else {
        bounds.startNode = bounds.endNode
        bounds.startOffset = bounds.endOffset
      }
    })
  }

  selectNode(node: Node): void {
    assertNode(node, "selectNode", "Range")
    const parent = parentOrThrow(node)
    const index = indexOfNode(node)
    const bounds = this.#bounds
    this.#changing(() => {
      bounds.startNode = parent
      bounds.startOffset = index
      bounds.endNode = parent
      bounds.endOffset = index + 1
    })
  }

  selectNodeContents(node: Node): void {
    assertNode(node, "selectNodeContents", "Range")
    const bounds = this.#bounds
    this.#changing(() => {
      bounds.startNode = node
      bounds.startOffset = 0
      bounds.endNode = node
      bounds.endOffset = nodeLength(node)
    })
  }

  cloneRange(): Range {
    const clone = new RangeClass()
    const from = this.#bounds
    const into = clone.#bounds
    into.startNode = from.startNode
    into.startOffset = from.startOffset
    into.endNode = from.endNode
    into.endOffset = from.endOffset
    return clone
  }

  /** Does nothing, as in the standard. */
  detach(): void {}

  compareBoundaryPoints(how: number, sourceRange: Range): number {
    if (!(sourceRange instanceof RangeClass)) {
      throw new TypeError("Failed to execute 'compareBoundaryPoints' on 'Range': parameter 2 is not of type 'Range'.")
    }
    const method = how & 0xffff
    if (method > END_TO_START) {
      throw namedError("NotSupportedError", `The comparison method provided (${how}) is not supported`)
    }
    const source = sourceRange.#bounds
    const own = this.#bounds
    if (rootOf(own.startNode) !== rootOf(source.startNode)) throw wrongDocumentError()
    const useOwnStart = method === START_TO_START || method === END_TO_START
    const useSourceStart = method === START_TO_START || method === START_TO_END
    return comparePoints(
      useOwnStart ? own.startNode : own.endNode,
      useOwnStart ? own.startOffset : own.endOffset,
      useSourceStart ? source.startNode : source.endNode,
      useSourceStart ? source.startOffset : source.endOffset
    )
  }

  isPointInRange(node: Node, offset: number): boolean {
    assertNode(node, "isPointInRange", "Range")
    if (rootOf(node) !== rootOf(this.#bounds.startNode)) return false
    const point = offset >>> 0
    if (point > nodeLength(node)) throw indexSizeError()
    return startPosition(this.#bounds, node, point) !== -1 && endPosition(this.#bounds, node, point) !== 1
  }

  comparePoint(node: Node, offset: number): number {
    assertNode(node, "comparePoint", "Range")
    assertSameRoot(this.#bounds, node)
    const point = offset >>> 0
    if (point > nodeLength(node)) throw indexSizeError()
    if (startPosition(this.#bounds, node, point) === -1) return -1
    if (endPosition(this.#bounds, node, point) === 1) return 1
    return 0
  }

  intersectsNode(node: Node): boolean {
    assertNode(node, "intersectsNode", "Range")
    if (rootOf(node) !== rootOf(this.#bounds.startNode)) return false
    const parent = node.parentNode
    if (parent === null) return true
    const index = indexOfNode(node)
    return endPosition(this.#bounds, parent, index) === -1 && startPosition(this.#bounds, parent, index + 1) === 1
  }

  toString(): string {
    const bounds = this.#bounds
    const start = bounds.startNode
    const end = bounds.endNode
    if (start === end && start.nodeType === TEXT_NODE) {
      return (start as Text).data.slice(bounds.startOffset, bounds.endOffset)
    }
    const parts: string[] = []
    if (start.nodeType === TEXT_NODE) parts.push((start as Text).data.slice(bounds.startOffset))
    for (const node of topmostContainedNodes(bounds)) appendContainedText(node, parts)
    if (end.nodeType === TEXT_NODE) parts.push((end as Text).data.slice(0, bounds.endOffset))
    return parts.join("")
  }

  deleteContents(): void {
    this.#changing(() => this.#deleteContents())
  }

  #deleteContents(): void {
    const bounds = this.#bounds
    if (bounds.startNode === bounds.endNode && bounds.startOffset === bounds.endOffset) return
    const startNode = bounds.startNode
    const startOffset = bounds.startOffset
    const endNode = bounds.endNode
    const endOffset = bounds.endOffset
    if (startNode === endNode && startNode instanceof CharacterData) {
      startNode.replaceData(startOffset, endOffset - startOffset, "")
      return
    }
    const toRemove = topmostContainedNodes(bounds)
    let newNode: Node
    let newOffset: number
    if (isInclusiveAncestor(startNode, endNode)) {
      newNode = startNode
      newOffset = startOffset
    } else {
      let reference = startNode
      for (let parent = reference.parentNode; parent !== null && !isInclusiveAncestor(parent, endNode); parent = reference.parentNode) {
        reference = parent
      }
      newNode = parentOrThrow(reference)
      newOffset = indexOfNode(reference) + 1
    }
    if (startNode instanceof CharacterData) {
      startNode.replaceData(startOffset, startNode.data.length - startOffset, "")
    }
    for (const node of toRemove) parentOrThrow(node).removeChild(node)
    if (endNode instanceof CharacterData) endNode.replaceData(0, endOffset, "")
    bounds.startNode = newNode
    bounds.startOffset = newOffset
    bounds.endNode = newNode
    bounds.endOffset = newOffset
  }

  insertNode(node: Node): void {
    assertNode(node, "insertNode", "Range")
    this.#changing(() => this.#insertNode(node))
  }

  #insertNode(node: Node): void {
    const bounds = this.#bounds
    const startNode = bounds.startNode
    const startIsText = startNode.nodeType === TEXT_NODE
    if (startNode === node || (startIsText && startNode.parentNode === null)) {
      throw namedError("HierarchyRequestError", "The range's start cannot take the node")
    }
    let reference: Node | null = startIsText ? startNode : (startNode[DOM_BINDING]().children[bounds.startOffset] ?? null)
    const parent: Node = reference === null ? startNode : parentOrThrow(reference)
    assertCanInsert(parent, node, reference)
    if (startIsText) reference = (startNode as Text).splitText(bounds.startOffset)
    if (node === reference) reference = node.nextSibling
    node.parentNode?.removeChild(node)
    const newOffset = (reference === null ? nodeLength(parent) : indexOfNode(reference)) + (node.nodeType === DOCUMENT_FRAGMENT_NODE ? nodeLength(node) : 1)
    parent.insertBefore(node, reference)
    if (bounds.startNode === bounds.endNode && bounds.startOffset === bounds.endOffset) {
      bounds.endNode = parent
      bounds.endOffset = newOffset
    }
  }

  cloneContents(): DocumentFragment {
    return cloneContentsOf(this.#bounds)
  }

  extractContents(): DocumentFragment {
    return this.#changing(() => extractContentsOf(this.#bounds))
  }

  /** Wraps what the range covers in `newParent`, emptied first: the contents are extracted into it, and it takes their place. */
  surroundContents(newParent: Node): void {
    assertNode(newParent, "surroundContents", "Range")
    const bounds = this.#bounds
    if (partiallyContainsNonText(bounds)) {
      throw namedError("InvalidStateError", "The range partially selects a node that is not text") as DOMException
    }
    if (newParent.nodeType === DOCUMENT_NODE || newParent.nodeType === DOCUMENT_FRAGMENT_NODE) {
      throw invalidNodeTypeError("A document or a fragment cannot wrap a range")
    }
    const fragment = this.extractContents()
    replaceChildren(newParent, [])
    this.insertNode(newParent)
    newParent.appendChild(fragment)
    this.selectNode(newParent)
  }

  getBoundingClientRect(): DOMRect {
    return rangeBoundingClientRect(this.#bounds)
  }

  getClientRects(): DOMRectList {
    return rangeClientRects(this.#bounds)
  }
}

/** What the `Selection` needs of the `Range` it holds: its boundary points, where it sets `onAdjust` to hear of every change to the range. */
export function boundariesOf(range: Range): RangeBoundaries {
  return range[BOUNDS]()
}

type RangeClassSet = {
  AbstractRange: typeof AbstractRangeClass
  StaticRange: typeof StaticRangeClass
  Range: typeof RangeClass
}

const RANGE_CLASSES_KEY = Symbol.for("@ghia/native/range-classes")

/** On `globalThis` like the DOM classes: a range from another copy of this package must pass `instanceof`. */
const shared: RangeClassSet = (() => {
  const existing = Reflect.get(globalThis, RANGE_CLASSES_KEY) as RangeClassSet | undefined
  if (existing) return existing
  const created: RangeClassSet = { AbstractRange: AbstractRangeClass, StaticRange: StaticRangeClass, Range: RangeClass }
  for (const name of Object.keys(created) as Array<keyof RangeClassSet>) {
    Object.defineProperty(created[name], "name", { value: name })
  }
  Reflect.set(globalThis, RANGE_CLASSES_KEY, created)
  return created
})()

export const AbstractRange = shared.AbstractRange
export type AbstractRange = AbstractRangeClass
export const StaticRange = shared.StaticRange
export type StaticRange = StaticRangeClass
export const Range = shared.Range
export type Range = RangeClass

Object.defineProperties(RangeClass.prototype, {
  START_TO_START: { value: START_TO_START, enumerable: true },
  START_TO_END: { value: START_TO_END, enumerable: true },
  END_TO_END: { value: END_TO_END, enumerable: true },
  END_TO_START: { value: END_TO_START, enumerable: true },
})
