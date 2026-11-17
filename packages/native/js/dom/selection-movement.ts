/**
 * The text model behind `Selection.modify()` and the Backspace and Delete of an editing host: the
 * Text nodes around a point in tree order, read as one string, and the point moved by a character
 * (grapheme cluster) or a word of it.
 *
 * It has no layout, so the line of a text and the visual order of bidirectional text are unknown:
 * `left` and `right` read as `backward` and `forward`. Moves by line are native's (`editing/line-movement.ts`),
 * and `paragraph` and `sentence` are not here (see deviations.md). A block element or a `<br>` between two Text
 * nodes reads as one `\n` that is not in any node, so a caret takes one step over a paragraph break
 * and none over the edge of an inline element. A `contenteditable="false"` element inside an editing
 * host is one atomic stop of one character, whatever it holds: a caret steps over it whole.
 *
 * Only the text around the point is read: the block it is in, and the block above that when the
 * step has nowhere to go inside the first.
 */

import { ownContentEditable, isEditingHost } from "../editing/host.js"
import type { Element, Node, Text } from "./nodes.js"
import { nextStop, type MovementGranularity } from "./text-segmentation.js"
import { comparePoints, indexOfNode, isInclusiveAncestor } from "./tree-order.js"

export type { MovementGranularity }

const ELEMENT_NODE = 1
const TEXT_NODE = 3

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "html", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul",
])

/** What an island is in the text: one character no real text has. */
const ISLAND_CHARACTER = "￼"

interface Point {
  node: Node
  offset: number
}

/** A Text node, or an island, with the stretch of the flat text it is and the points around it. */
interface Segment {
  node: Text | Element
  island: boolean
  start: number
  end: number
  before: Point
  after: Point
}

interface Flat {
  text: string
  segments: Segment[]
}

function elementTag(node: Node): string | undefined {
  return node.nodeType === ELEMENT_NODE ? (node as Element).localName : undefined
}

function isBlock(node: Node): boolean {
  const tag = elementTag(node)
  return tag !== undefined && BLOCK_TAGS.has(tag)
}

function flatten(scope: Node, islands: boolean): Flat {
  const segments: Segment[] = []
  let text = ""
  let separatorOwed = false
  const flush = (): void => {
    if (separatorOwed && text.length > 0) text += "\n"
    separatorOwed = false
  }
  const visit = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (child.nodeType === TEXT_NODE) {
        flush()
        const data = (child as Text).data
        segments.push({
          node: child as Text,
          island: false,
          start: text.length,
          end: text.length + data.length,
          before: { node: child, offset: 0 },
          after: { node: child, offset: data.length },
        })
        text += data
        continue
      }
      const tag = elementTag(child)
      if (tag === undefined) continue
      if (islands && ownContentEditable(child as Element) === "false") {
        flush()
        const index = indexOfNode(child)
        segments.push({
          node: child as Element,
          island: true,
          start: text.length,
          end: text.length + ISLAND_CHARACTER.length,
          before: { node: parent, offset: index },
          after: { node: parent, offset: index + 1 },
        })
        text += ISLAND_CHARACTER
      } else if (tag === "br") {
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

/** The nearest block holding `node` (or `node` itself, a block), below `scope`; `scope` when none does. */
function enclosingBlock(node: Node, scope: Node): Node {
  for (let current: Node | null = node; current !== null && current !== scope; current = current.parentNode) {
    if (isBlock(current)) return current
  }
  return scope
}

/** The offset in `flat.text` of a boundary point, or `undefined` when the text has no segment the point belongs to. */
function offsetOf(flat: Flat, scope: Node, node: Node, offset: number): number | undefined {
  if (flat.segments.length === 0) return undefined
  if (node.nodeType === TEXT_NODE) {
    const found = flat.segments.find((segment) => segment.node === node)
    return found === undefined ? undefined : found.start + offset
  }
  let previous: Segment | undefined
  let next: Segment | undefined
  for (const segment of flat.segments) {
    if (comparePoints(segment.after.node, segment.after.offset, node, offset) <= 0) previous = segment
    else if (comparePoints(segment.before.node, segment.before.offset, node, offset) >= 0) {
      next = segment
      break
    }
  }
  if (previous === undefined) return next === undefined ? undefined : next.start
  if (next === undefined || next.start === previous.end) return previous.end
  const insidePrevious = isInclusiveAncestor(enclosingBlock(previous.node.parentNode as Node, scope), node)
  const insideNext = isInclusiveAncestor(enclosingBlock(next.node.parentNode as Node, scope), node)
  return insidePrevious && !insideNext ? previous.end : next.start
}

function pointOf(flat: Flat, offset: number): Point {
  const segment = flat.segments.find((candidate) => offset >= candidate.start && offset <= candidate.end)
  if (segment === undefined) throw new Error(`Offset ${offset} is not inside any Text node of the scope`)
  if (segment.island) return offset === segment.start ? segment.before : segment.after
  return { node: segment.node, offset: offset - segment.start }
}

export interface MovedPoint {
  node: Node
  offset: number
}

/** A move and the island it went over, if the step was over one. */
export interface Step extends MovedPoint {
  island: Element | null
}

/**
 * `(node, offset)` moved one `granularity` unit of the text under `scope`, or `null` when it cannot
 * move: the scope has no text, the point is not in it, or the point is already at that edge.
 * `island` is the `contenteditable="false"` element the step went over, whole, when it was one.
 */
export function stepPoint(
  scope: Node,
  node: Node,
  offset: number,
  forward: boolean,
  granularity: MovementGranularity
): Step | null {
  const islands = isEditingHost(scope as Element)
  for (let block = enclosingBlock(node, scope); ; block = enclosingBlock(block.parentNode as Node, scope)) {
    const flat = flatten(block, islands)
    const from = offsetOf(flat, block, node, offset)
    if (from === undefined) return null
    const to = nextStop(flat.text, from, forward, granularity)
    if (to !== undefined) {
      const found = pointOf(flat, to)
      const low = Math.min(from, to)
      const high = Math.max(from, to)
      const crossed = flat.segments.find((segment) => segment.island && segment.start === low && segment.end === high)
      return { node: found.node, offset: found.offset, island: crossed === undefined ? null : (crossed.node as Element) }
    }
    // Nothing further inside this block: the step crosses its edge, into the text around it.
    if (block === scope) return null
  }
}

/** `stepPoint` without the island: where the point lands. */
export function movePoint(
  scope: Node,
  node: Node,
  offset: number,
  forward: boolean,
  granularity: MovementGranularity
): MovedPoint | null {
  return stepPoint(scope, node, offset, forward, granularity)
}
