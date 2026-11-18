/**
 * Moving a position by lines of the painted text, for `Selection.modify` with the `line`,
 * `lineboundary` and `documentboundary` granularities. Where a line starts and ends is native's
 * ([`moveCaretVisually`]). A position with no Text node next to it has no line of its own unless it is in
 * an empty line (`<p><br></p>`), which native knows by its block: a line like any other for a move up
 * or down, and the only one that has no boundary to go to.
 */

import type { Node } from "../dom/nodes.js"
import { moveCaretVisually, textEdge, textPointOf } from "./geometry.js"

const ELEMENT_NODE = 1

export interface MovedPosition {
  node: Node
  offset: number
  /** The window x a following move up or down keeps, or `null` when this move starts a new run. */
  goalX: number | null
}

function isInclusiveDescendant(node: Node, ancestor: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

/**
 * One line up or down from `(node, offset)`, staying in `scope`. `goalX` is the x the run of moves it
 * is part of keeps, so a caret passing a short line comes back to its column. With no line left in the
 * scope the position goes to the edge of its text, as the caret does on macOS, and none when it is
 * already there.
 */
export function moveByLine(scope: Node, node: Node, offset: number, down: boolean, goalX: number | null): MovedPosition | null {
  const from = textPointOf(node, offset)
  if (from === null) return moveFromEmptyLine(scope, node, offset, down, goalX)
  const target = moveCaretVisually(from, down ? "lineDown" : "lineUp", goalX)
  if (target !== null && isInclusiveDescendant(target.node, scope)) {
    return { node: target.node, offset: target.offset, goalX: target.x }
  }
  const edge = textEdge(scope, down ? "end" : "start")
  if (edge === null || (edge.node === from.node && edge.offset === from.offset)) return null
  return { node: edge.node, offset: edge.offset, goalX: null }
}

/**
 * One line up or down from a position that has no text next to it. Native moves it when it is in an
 * empty line; that line is the edge of its text, so there is none to go to at the ends of the scope.
 */
function moveFromEmptyLine(scope: Node, node: Node, offset: number, down: boolean, goalX: number | null): MovedPosition | null {
  if (node.nodeType !== ELEMENT_NODE) return null
  const target = moveCaretVisually({ node, offset }, down ? "lineDown" : "lineUp", goalX)
  if (target === null || !isInclusiveDescendant(target.node, scope)) return null
  return { node: target.node, offset: target.offset, goalX: target.x }
}

/** The start or the end of the line `(node, offset)` is on. */
export function moveToLineBoundary(node: Node, offset: number, forward: boolean): MovedPosition | null {
  const from = textPointOf(node, offset)
  if (from === null) return null
  const target = moveCaretVisually(from, forward ? "lineEnd" : "lineStart", null)
  return target === null ? null : { node: target.node, offset: target.offset, goalX: null }
}

/** The first or the last position of the text in `scope`, or of the scope itself when it holds none. */
export function moveToDocumentBoundary(scope: Node, forward: boolean): MovedPosition {
  const edge = textEdge(scope, forward ? "end" : "start")
  if (edge !== null) return { node: edge.node, offset: edge.offset, goalX: null }
  return { node: scope, offset: forward ? scope.childNodes.length : 0, goalX: null }
}
