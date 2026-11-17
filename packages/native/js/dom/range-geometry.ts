/**
 * `Range.getClientRects()` and `Range.getBoundingClientRect()`, by the CSSOM View rules: the rect of
 * each line fragment of the text a range selects, and the border boxes of the elements it selects
 * whole, where an element inside a selected element adds none of its own. The text rects come from
 * native, which knows where each line of a paragraph was painted (`editing/geometry.ts`).
 */

import { textRects } from "../editing/geometry.js"
import { comparePoints } from "./tree-order.js"
import { DOMRect, DOMRectList } from "./dom-rect.js"
import type { RangeBoundaries } from "./live-ranges.js"
import type { Element, Node, Text } from "./nodes.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3

function isInclusiveAncestor(ancestor: Node, node: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

function commonAncestor(left: Node, right: Node): Node {
  let ancestor = left
  while (!isInclusiveAncestor(ancestor, right)) {
    const parent = ancestor.parentNode
    if (parent === null) throw new Error("The ends of a range are in different trees")
    ancestor = parent
  }
  return ancestor
}

export function rangeClientRects(bounds: RangeBoundaries): DOMRectList {
  const rects = new DOMRectList()
  const { startNode, startOffset, endNode, endOffset } = bounds
  if (startNode.nodeType === TEXT_NODE && startNode === endNode) {
    rects.push(...textRects(startNode as Text, startOffset, endOffset))
    return rects
  }
  const visit = (parent: Node, parentSelected: boolean): void => {
    const children = parent.childNodes
    for (let index = 0; index < children.length; index++) {
      if (comparePoints(parent, index + 1, startNode, startOffset) <= 0) continue
      if (comparePoints(parent, index, endNode, endOffset) >= 0) break
      const child = children[index]!
      if (child.nodeType === TEXT_NODE) {
        const text = child as Text
        const from = text === startNode ? startOffset : 0
        const to = text === endNode ? endOffset : text.data.length
        if (from < to) rects.push(...textRects(text, from, to))
      } else if (child.nodeType === ELEMENT_NODE) {
        const selected =
          comparePoints(parent, index, startNode, startOffset) >= 0 && comparePoints(parent, index + 1, endNode, endOffset) <= 0
        if (selected && !parentSelected) rects.push(...(child as Element).getClientRects())
        visit(child, parentSelected || selected)
      }
    }
  }
  visit(commonAncestor(startNode, endNode), false)
  return rects
}

/** The smallest rect that holds every rect `rangeClientRects` gives, or an empty one when it gives none. */
export function rangeBoundingClientRect(bounds: RangeBoundaries): DOMRect {
  const rects = rangeClientRects(bounds)
  if (rects.length === 0) return new DOMRect()
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  return new DOMRect(left, top, right - left, bottom - top)
}
