/**
 * Where nodes and boundary points are in a tree, from the DOM standard's "tree order", "length",
 * "index" and "position of a boundary point". `range.ts`, `live-ranges.ts`, `selection.ts`,
 * `selection-movement.ts` and the editing code share it, so none of them keeps its own copy.
 *
 * Nodes are read through their public members and `[DOM_BINDING]()` (an array the adapter owns,
 * which `childNodes` would copy), and nothing here reads another module's top-level state, so
 * `live-ranges.ts` can import it while `nodes.ts` imports `live-ranges.ts`.
 */

import { DOM_BINDING, indexOfNode, type CharacterData, type Node } from "./nodes.js"

const TEXT_NODE = 3
const PROCESSING_INSTRUCTION_NODE = 7
const COMMENT_NODE = 8

export { indexOfNode }

/** "Length": the code units of character data, else the number of children. */
export function nodeLength(node: Node): number {
  const type = node.nodeType
  if (type === TEXT_NODE || type === COMMENT_NODE || type === PROCESSING_INSTRUCTION_NODE) {
    return (node as CharacterData).data.length
  }
  return node[DOM_BINDING]().children.length
}

/** The number of children a node has; 0 for text. */
export function childCount(node: Node): number {
  return node[DOM_BINDING]().children.length
}

export function rootOf(node: Node): Node {
  let top = node
  for (let parent = top.parentNode; parent !== null; parent = top.parentNode) top = parent
  return top
}

/** Whether `ancestor` is `node` or above it. */
export function isInclusiveAncestor(ancestor: Node, node: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

/**
 * Whether `node` is `ancestor` or below it, looking no higher than `stop`: a `node` that reaches
 * `stop` without meeting `ancestor` is not under it, as long as `ancestor` is under `stop`.
 */
export function isInclusiveDescendantBelow(node: Node, ancestor: Node, stop: Node): boolean {
  for (let current: Node | null = node; current !== null && current !== stop; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

function depthOf(node: Node): number {
  let depth = 0
  for (let parent = node.parentNode; parent !== null; parent = parent.parentNode) depth += 1
  return depth
}

/**
 * The position of boundary point A relative to B, as the DOM standard's "position of a boundary
 * point": -1 for before, 0 for equal, 1 for after. Both nodes must be in the same tree.
 */
export function comparePoints(nodeA: Node, offsetA: number, nodeB: Node, offsetB: number): -1 | 0 | 1 {
  if (nodeA === nodeB) {
    if (offsetA === offsetB) return 0
    return offsetA < offsetB ? -1 : 1
  }
  let a = nodeA
  let b = nodeB
  let depthA = depthOf(a)
  let depthB = depthOf(b)
  let childOfA: Node | null = null
  let childOfB: Node | null = null
  for (; depthA > depthB; depthA -= 1) {
    childOfA = a
    a = a.parentNode as Node
  }
  for (; depthB > depthA; depthB -= 1) {
    childOfB = b
    b = b.parentNode as Node
  }
  if (a === b) {
    // One node holds the other: the point in the holder is before the child at its offset.
    if (childOfB !== null) return indexOfNode(childOfB) < offsetA ? 1 : -1
    if (childOfA === null) throw new Error("Two different nodes at the same depth met")
    return indexOfNode(childOfA) < offsetB ? -1 : 1
  }
  while (a.parentNode !== b.parentNode) {
    a = a.parentNode as Node
    b = b.parentNode as Node
  }
  if (a.parentNode === null) throw new Error("The two boundary points are not in the same tree")
  return indexOfNode(a) < indexOfNode(b) ? -1 : 1
}
