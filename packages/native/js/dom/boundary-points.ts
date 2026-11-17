import type { Node } from "./nodes.js"

const DOCUMENT_POSITION_FOLLOWING = 4

function isAncestor(ancestor: Node, node: Node): boolean {
  for (let current = node.parentNode; current !== null; current = current.parentNode) {
    if (current === ancestor) return true
  }
  return false
}

function childOfAncestorThatContains(ancestor: Node, node: Node): Node {
  let child = node
  while (child.parentNode !== ancestor) {
    if (child.parentNode === null) throw new Error("The node is not inside the ancestor")
    child = child.parentNode
  }
  return child
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
  if (nodeB.compareDocumentPosition(nodeA) & DOCUMENT_POSITION_FOLLOWING) {
    return comparePoints(nodeB, offsetB, nodeA, offsetA) === -1 ? 1 : -1
  }
  if (isAncestor(nodeA, nodeB)) {
    const child = childOfAncestorThatContains(nodeA, nodeB)
    return nodeA.childNodes.indexOf(child) < offsetA ? 1 : -1
  }
  return -1
}
