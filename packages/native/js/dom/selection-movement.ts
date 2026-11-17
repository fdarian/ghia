/**
 * The text model behind `Selection.modify()`: the Text nodes under a scope in tree order, read as
 * one string, and a boundary point moved by a character (grapheme cluster) or a word of it.
 *
 * It has no layout, so the line of a text and the visual order of bidirectional text are unknown:
 * `left` and `right` read as `backward` and `forward`, and `line`, `paragraph` and the other
 * granularities are not here (see deviations.md). A block element or a `<br>` between two Text
 * nodes reads as one `\n` that is not in any node, so a caret takes one step over a paragraph break
 * and none over the edge of an inline element.
 */

import { comparePoints } from "./boundary-points.js"
import type { Element, Node, Text } from "./nodes.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "html", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul",
])

interface Segment {
  node: Text
  start: number
  end: number
}

interface Flat {
  text: string
  segments: Segment[]
}

export type MovementGranularity = "character" | "word"

function elementTag(node: Node): string | undefined {
  return node.nodeType === ELEMENT_NODE ? (node as Element).localName : undefined
}

function flatten(scope: Node): Flat {
  const segments: Segment[] = []
  let text = ""
  let separatorOwed = false
  const visit = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (child.nodeType === TEXT_NODE) {
        if (separatorOwed && text.length > 0) text += "\n"
        separatorOwed = false
        const data = (child as Text).data
        segments.push({ node: child as Text, start: text.length, end: text.length + data.length })
        text += data
        continue
      }
      const tag = elementTag(child)
      if (tag === undefined) continue
      if (tag === "br") {
        separatorOwed = true
      } else if (BLOCK_TAGS.has(tag)) {
        separatorOwed = true
        visit(child)
        separatorOwed = true
      } else {
        visit(child)
      }
    }
  }
  visit(scope)
  return { text, segments }
}

function isInclusiveDescendant(node: Node, ancestor: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

function blockOf(node: Node, scope: Node): Node {
  for (let current = node.parentNode; current !== null && current !== scope; current = current.parentNode) {
    const tag = elementTag(current)
    if (tag !== undefined && BLOCK_TAGS.has(tag)) return current
  }
  return scope
}

/** The offset in `flat.text` of a boundary point, or `undefined` when the text has no Text node. */
function offsetOf(flat: Flat, scope: Node, node: Node, offset: number): number | undefined {
  if (flat.segments.length === 0) return undefined
  if (node.nodeType === TEXT_NODE) {
    const found = flat.segments.find((segment) => segment.node === node)
    return found === undefined ? undefined : found.start + offset
  }
  let previous: Segment | undefined
  let next: Segment | undefined
  for (const segment of flat.segments) {
    if (comparePoints(segment.node, segment.node.data.length, node, offset) <= 0) previous = segment
    else if (comparePoints(segment.node, 0, node, offset) >= 0) {
      next = segment
      break
    }
  }
  if (previous === undefined) return next === undefined ? undefined : next.start
  if (next === undefined || next.start === previous.end) return previous.end
  const insidePrevious = isInclusiveDescendant(node, blockOf(previous.node, scope))
  const insideNext = isInclusiveDescendant(node, blockOf(next.node, scope))
  return insidePrevious && !insideNext ? previous.end : next.start
}

function pointOf(flat: Flat, offset: number): { node: Text; offset: number } {
  const segment = flat.segments.find((candidate) => offset >= candidate.start && offset <= candidate.end)
  if (segment === undefined) throw new Error(`Offset ${offset} is not inside any Text node of the scope`)
  return { node: segment.node, offset: offset - segment.start }
}

const segmenters: Partial<Record<MovementGranularity, Intl.Segmenter>> = {}

function segmenter(granularity: MovementGranularity): Intl.Segmenter | undefined {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return undefined
  const existing = segmenters[granularity]
  if (existing !== undefined) return existing
  const created = new Intl.Segmenter(undefined, { granularity: granularity === "word" ? "word" : "grapheme" })
  segmenters[granularity] = created
  return created
}

/** Whether `text` is exactly one grapheme cluster: what a typed key is. */
export function isSingleGrapheme(text: string): boolean {
  if (text === "") return false
  const segments = segmenter("character")
  if (segments === undefined) return [...text].length === 1
  const pieces = segments.segment(text)[Symbol.iterator]()
  pieces.next()
  return pieces.next().done === true
}

/** Where a caret may stop going `forward` or backward in `text`, ascending. */
function stopsOf(text: string, granularity: MovementGranularity, forward: boolean): number[] {
  const stops = [0, text.length]
  const segments = segmenter(granularity)
  if (segments !== undefined) {
    for (const piece of segments.segment(text)) {
      if (granularity === "word") {
        if (piece.isWordLike) stops.push(forward ? piece.index + piece.segment.length : piece.index)
      } else {
        stops.push(piece.index)
      }
    }
  } else if (granularity === "word") {
    for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) stops.push(forward ? match.index + match[0].length : match.index)
  } else {
    let index = 0
    for (const codePoint of text) {
      stops.push(index)
      index += codePoint.length
    }
  }
  return stops.sort((a, b) => a - b)
}

export interface MovedPoint {
  node: Node
  offset: number
}

/**
 * `(node, offset)` moved one `granularity` unit of the text under `scope`, or `null` when it cannot
 * move: the scope has no text, the point is not in it, or the point is already at that edge.
 */
export function movePoint(
  scope: Node,
  node: Node,
  offset: number,
  forward: boolean,
  granularity: MovementGranularity
): MovedPoint | null {
  const flat = flatten(scope)
  const from = offsetOf(flat, scope, node, offset)
  if (from === undefined) return null
  const stops = stopsOf(flat.text, granularity, forward)
  const to = forward ? stops.find((stop) => stop > from) : stops.filter((stop) => stop < from).pop()
  if (to === undefined) return null
  return pointOf(flat, to)
}
