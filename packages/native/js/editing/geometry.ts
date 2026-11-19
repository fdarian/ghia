/**
 * Where DOM positions are on screen, read from the text native painted: the rects of a range of
 * text, the position at a point and a position moved along the lines of the paragraph. Native does
 * the layout work (`getTextRangeRects`, `caretPositionFromPoint`, `moveCaretVisually`); this module
 * finds the node ids to ask about, and the nodes the answers name.
 *
 * Only Text nodes have a place in the painted text: a position inside an element is resolved to the
 * Text node next to it first ([`textPointOf`]).
 */

import { flushPendingMutations } from "../bounds.js"
import { DOMRect } from "../dom/dom-rect.js"
import { DOM_BINDING, type Element, type ElementBinding, type Node, type Text, type TextBinding } from "../dom/nodes.js"
import type { NativeRenderer } from "../host.js"
import { mountedRenderer } from "../mounted-renderer.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** A position in a Text node. */
export interface TextPoint {
  node: Text
  offset: number
}

/** A position in a Text node with where its caret is: the x is in window coordinates. */
export interface CaretTarget extends TextPoint {
  x: number
}

/** A position in any node, with where its caret is: a Text node, or an element that is an empty line. */
export interface LineTarget {
  node: Node
  offset: number
  x: number
}

interface NativeText {
  renderer: NativeRenderer
  id: number
}

function nativeOf(text: Text): NativeText | undefined {
  return (text[DOM_BINDING]() as TextBinding).native
}

function isText(node: Node): node is Text {
  return node.nodeType === TEXT_NODE
}

function firstText(root: Node): Text | null {
  if (isText(root)) return root
  for (const child of root.childNodes) {
    const found = firstText(child)
    if (found !== null) return found
  }
  return null
}

function lastText(root: Node): Text | null {
  if (isText(root)) return root
  const children = root.childNodes
  for (let index = children.length - 1; index >= 0; index--) {
    const found = lastText(children[index]!)
    if (found !== null) return found
  }
  return null
}

/**
 * The position in a Text node that `(node, offset)` is next to: the node itself for a Text node, else
 * the start of the first Text at or after the offset in the node's children, or the end of the last
 * Text before it. `null` when the node holds no text there.
 */
export function textPointOf(node: Node, offset: number): TextPoint | null {
  if (isText(node)) return { node, offset }
  const children = node.childNodes
  if (offset < children.length) {
    const next = firstText(children[offset]!)
    if (next !== null) return { node: next, offset: 0 }
  }
  for (let index = Math.min(offset, children.length) - 1; index >= 0; index--) {
    const previous = lastText(children[index]!)
    if (previous !== null) return { node: previous, offset: previous.data.length }
  }
  return null
}

/** The first and the last position of the text under `root`, or `null` when it has none. */
export function textEdge(root: Node, edge: "start" | "end"): TextPoint | null {
  if (edge === "start") {
    const first = firstText(root)
    return first === null ? null : { node: first, offset: 0 }
  }
  const last = lastText(root)
  return last === null ? null : { node: last, offset: last.data.length }
}

type PaintedTextReads = Required<Pick<NativeRenderer, "getTextRangeRects" | "caretPositionFromPoint" | "moveCaretVisually">>

function requireMethod<K extends keyof PaintedTextReads>(renderer: NativeRenderer, name: K, member: string): PaintedTextReads[K] {
  const method = renderer[name]
  if (method === undefined) {
    throw new Error(`This renderer cannot read the painted text, so ${member} is unavailable`)
  }
  const call = method as (...args: unknown[]) => unknown
  return ((...args: unknown[]) => call.apply(renderer, args)) as PaintedTextReads[K]
}

/** The window coordinates of each line fragment of the text of `node` between two offsets: none when it did not paint. */
export function textRects(node: Text, start: number, end: number): DOMRect[] {
  const native = nativeOf(node)
  if (native === undefined) return []
  const read = requireMethod(native.renderer, "getTextRangeRects", "Range.getClientRects")
  flushPendingMutations(native.renderer)
  return read(native.id, start, native.id, end).map((rect) => new DOMRect(rect.x, rect.y, rect.width, rect.height))
}

/** The Text node under `root` that native knows as `id`, or `null`. */
export function textById(root: Node, id: number): Text | null {
  for (const child of root.childNodes) {
    if (isText(child)) {
      if (nativeOf(child)?.id === id) return child
    } else if (child.nodeType === ELEMENT_NODE) {
      const found = textById(child, id)
      if (found !== null) return found
    }
  }
  return null
}

interface NativeCaret {
  nodeId: number
  containerId: number
  offset: number
  x: number
}

type ElementLookup = (renderer: object, id: number) => object | undefined

let elementLookup: ElementLookup | undefined

/**
 * How a node id native names becomes the element that paints it. The document installs it, which this
 * module cannot import: the document is built from the nodes this module's callers define.
 */
export function setElementLookup(lookup: ElementLookup): void {
  elementLookup = lookup
}

function targetOf(renderer: NativeRenderer, caret: NativeCaret): CaretTarget {
  const container = elementLookup?.(renderer, caret.containerId) as Element | undefined
  const node = container === undefined ? null : textById(container, caret.nodeId)
  if (node === null) {
    throw new Error(`Text node ${caret.nodeId} is painted by element ${caret.containerId}, which has no such text`)
  }
  return { node, offset: caret.offset, x: caret.x }
}

/** The position at the window point, in the text under it or the nearest, or `null` when no text painted. */
export function caretFromPoint(x: number, y: number): CaretTarget | null {
  const renderer = mountedRenderer()
  if (renderer === undefined) {
    throw new Error("caretPositionFromPoint needs a mounted GPUIX root. Call it after render().")
  }
  const read = requireMethod(renderer, "caretPositionFromPoint", "document.caretPositionFromPoint")
  flushPendingMutations(renderer)
  const caret = read(x, y)
  return caret === null ? null : targetOf(renderer, caret)
}

export type CaretMove = "lineUp" | "lineDown" | "lineStart" | "lineEnd"

/**
 * `point` moved along the lines of the painted text. `goalX` is the window x that a run of moves up
 * and down keeps; it is the caret's own when `null`. `null` when there is no line to go to, and when
 * the text did not paint.
 *
 * `point` is in a Text node or, for an empty line (`<p><br></p>`, which paints no text), in the element
 * that is the line: native says which elements are, and has no line to move from for any other. The
 * target is in an empty line the same way when the line is where the move goes.
 */
export function moveCaretVisually(point: { node: Node; offset: number }, move: CaretMove, goalX: number | null): LineTarget | null {
  const native = isText(point.node) ? nativeOf(point.node) : (point.node[DOM_BINDING]() as ElementBinding).native
  if (native === undefined) return null
  const read = requireMethod(native.renderer, "moveCaretVisually", "Selection.modify")
  flushPendingMutations(native.renderer)
  const caret = read(native.id, point.offset, move, goalX)
  if (caret === null) return null
  // Native names an empty line by its block, as the text and the container of the position.
  if (caret.nodeId === caret.containerId) {
    const block = elementLookup?.(native.renderer, caret.containerId) as Element | undefined
    if (block === undefined) throw new Error(`Element ${caret.containerId} is an empty line, which is not in the document`)
    return { node: block, offset: caret.offset, x: caret.x }
  }
  return targetOf(native.renderer, caret)
}

/** The caret rect of a position in a Text node (no width, the height of the font there), or `null` when it did not paint. */
export function caretRect(point: TextPoint): DOMRect | null {
  return textRects(point.node, point.offset, point.offset)[0] ?? null
}
