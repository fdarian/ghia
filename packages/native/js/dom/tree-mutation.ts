/**
 * The DOM's tree-changing algorithms (`appendChild`, `insertBefore`, `replaceChild`,
 * `before`, `replaceWith`, `insertAdjacentElement`, ...), written once over the two
 * primitives an adapter's binding gives: place a node before another, take a node out.
 * What the adapter does behind them (its mirror, the native tree, `MutationObserver`
 * records) is its own; the validation, the argument handling and the return values are
 * the DOM's and live here.
 */

import { DOM_BINDING, Element, Node, type NodeBinding, type ParentBinding } from "./nodes.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const DOCUMENT_NODE = 9

function hierarchyRequestError(message: string): DOMException {
  return new DOMException(message, "HierarchyRequestError")
}

/** What a thrown error of this DOM name looks like, for an adapter that has to refuse a move. */
export function crossRootError(): DOMException {
  return hierarchyRequestError(
    "A node cannot be moved into a tree of another window: each window's tree is its own root"
  )
}

function isParentBinding(binding: NodeBinding): binding is ParentBinding {
  return typeof (binding as Partial<ParentBinding>).insertBefore === "function"
}

function parentBindingOf(parent: Node): ParentBinding {
  const binding = parent[DOM_BINDING]()
  if (isParentBinding(binding)) return binding
  if (parent.nodeType === DOCUMENT_NODE) {
    throw hierarchyRequestError(
      "The document's own children are the window roots; add nodes to document.body or document.head instead"
    )
  }
  throw hierarchyRequestError("This node type does not support this method")
}

function assertNode(value: unknown, method: string, owner: string, position: number): asserts value is Node {
  if (!(value instanceof Node)) {
    throw new TypeError(
      `Failed to execute '${method}' on '${owner}': parameter ${position} is not of type 'Node'.`
    )
  }
}

/** The DOM's "ensure pre-insertion validity", for the node types that exist here. */
function assertCanInsert(parent: Node, node: Node, before: Node | null): ParentBinding {
  const binding = parentBindingOf(parent)
  if (node.nodeType !== ELEMENT_NODE && node.nodeType !== TEXT_NODE) {
    throw hierarchyRequestError(`Nodes of type '${node.nodeName}' may not be inserted inside nodes of type '${parent.nodeName}'`)
  }
  if (node.contains(parent)) {
    throw hierarchyRequestError("The new child element contains the parent")
  }
  if (before !== null && before.parentNode !== parent) {
    throw new DOMException("The node before which the new node is to be inserted is not a child of this node", "NotFoundError")
  }
  return binding
}

/** A writer of several nodes validates all of them before it moves one, so a bad later node leaves the earlier ones where they were. */
function assertAllCanInsert(parent: Node, nodes: readonly Node[]): void {
  for (const node of nodes) assertCanInsert(parent, node, null)
}

function insertNode(parent: Node, node: Node, before: Node | null): void {
  const binding = assertCanInsert(parent, node, before)
  // Inserting a node before itself leaves it where it is.
  binding.insertBefore(node, before === node ? node.nextSibling : before)
}

function removeNode(parent: Node, child: Node): void {
  parentBindingOf(parent).removeChild(child)
}

export function appendChild<Child extends Node>(parent: Node, node: Child): Child {
  assertNode(node, "appendChild", "Node", 1)
  insertNode(parent, node, null)
  return node
}

export function insertBefore<Child extends Node>(parent: Node, node: Child, before: Node | null | undefined): Child {
  assertNode(node, "insertBefore", "Node", 1)
  if (before !== null && before !== undefined) assertNode(before, "insertBefore", "Node", 2)
  insertNode(parent, node, before ?? null)
  return node
}

export function removeChild<Child extends Node>(parent: Node, child: Child): Child {
  assertNode(child, "removeChild", "Node", 1)
  if (child.parentNode !== parent) {
    throw new DOMException("The node to be removed is not a child of this node", "NotFoundError")
  }
  removeNode(parent, child)
  return child
}

export function replaceChild<Child extends Node>(parent: Node, node: Node, child: Child): Child {
  assertNode(node, "replaceChild", "Node", 1)
  assertNode(child, "replaceChild", "Node", 2)
  if (child.parentNode !== parent) {
    throw new DOMException("The node to be replaced is not a child of this node", "NotFoundError")
  }
  assertCanInsert(parent, node, null)
  const reference = child.nextSibling === node ? node.nextSibling : child.nextSibling
  removeNode(parent, child)
  insertNode(parent, node, reference)
  return child
}

/** What `textContent = value` does: every child goes, and a non-empty string becomes the one child. */
export function replaceAllWithText(parent: Node, value: string | null): void {
  const text = value === null ? "" : String(value)
  const binding = parentBindingOf(parent)
  for (const child of binding.children.slice()) binding.removeChild(child)
  if (text !== "") binding.insertBefore(binding.createText(text), null)
}

function toNodes(binding: ParentBinding, items: readonly (Node | string)[]): Node[] {
  return items.map((item) => (item instanceof Node ? item : binding.createText(String(item))))
}

function viableSibling(from: Node | null, excluded: readonly Node[], step: (node: Node) => Node | null): Node | null {
  let node = from
  while (node !== null && excluded.includes(node)) node = step(node)
  return node
}

function detach(node: Node): void {
  const parent = node.parentNode
  if (parent !== null) removeNode(parent, node)
}

export function remove(node: Node): void {
  const parent = node.parentNode
  if (parent !== null) removeNode(parent, node)
}

export function before(node: Node, items: readonly (Node | string)[]): void {
  const parent = node.parentNode
  if (parent === null) return
  const nodes = toNodes(parentBindingOf(parent), items)
  assertAllCanInsert(parent, nodes)
  if (!nodes.includes(node)) {
    for (const item of nodes) insertNode(parent, item, node)
    return
  }
  // The node is moved too, so the place to insert at is found without it and the nodes.
  const previous = viableSibling(node.previousSibling, nodes, (sibling) => sibling.previousSibling)
  for (const item of nodes) detach(item)
  const reference = previous === null ? parent.firstChild : previous.nextSibling
  for (const item of nodes) insertNode(parent, item, reference)
}

export function after(node: Node, items: readonly (Node | string)[]): void {
  const parent = node.parentNode
  if (parent === null) return
  const nodes = toNodes(parentBindingOf(parent), items)
  assertAllCanInsert(parent, nodes)
  const reference = viableSibling(node.nextSibling, nodes, (sibling) => sibling.nextSibling)
  if (nodes.includes(node)) for (const item of nodes) detach(item)
  for (const item of nodes) insertNode(parent, item, reference)
}

export function replaceWith(node: Node, items: readonly (Node | string)[]): void {
  const parent = node.parentNode
  if (parent === null) return
  const nodes = toNodes(parentBindingOf(parent), items)
  assertAllCanInsert(parent, nodes)
  const reference = viableSibling(node.nextSibling, nodes, (sibling) => sibling.nextSibling)
  if (nodes.includes(node)) {
    for (const item of nodes) detach(item)
    for (const item of nodes) insertNode(parent, item, reference)
    return
  }
  // Inserted first, so a node that cannot go here leaves this one in place.
  for (const item of nodes) insertNode(parent, item, reference)
  removeNode(parent, node)
}

export function append(parent: Node, items: readonly (Node | string)[]): void {
  const nodes = toNodes(parentBindingOf(parent), items)
  assertAllCanInsert(parent, nodes)
  for (const item of nodes) insertNode(parent, item, null)
}

export function prepend(parent: Node, items: readonly (Node | string)[]): void {
  const nodes = toNodes(parentBindingOf(parent), items)
  assertAllCanInsert(parent, nodes)
  const reference = viableSibling(parent.firstChild, nodes, (sibling) => sibling.nextSibling)
  for (const item of nodes) insertNode(parent, item, reference)
}

export function replaceChildren(parent: Node, items: readonly (Node | string)[]): void {
  const binding = parentBindingOf(parent)
  const nodes = toNodes(binding, items)
  assertAllCanInsert(parent, nodes)
  for (const child of binding.children.slice()) if (!nodes.includes(child)) binding.removeChild(child)
  for (const item of nodes) insertNode(parent, item, null)
}

/** The node and where it goes for one of the four positions, or `null` when it has no parent to go beside. */
function adjacentPlace(element: Node, where: string): { parent: Node; before: Node | null } | null {
  switch (where.toLowerCase()) {
    case "beforebegin": {
      const parent = element.parentNode
      return parent === null ? null : { parent, before: element }
    }
    case "afterbegin":
      return { parent: element, before: element.firstChild }
    case "beforeend":
      return { parent: element, before: null }
    case "afterend": {
      const parent = element.parentNode
      return parent === null ? null : { parent, before: element.nextSibling }
    }
    default:
      throw new DOMException(
        `The value provided ('${where}') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'`,
        "SyntaxError"
      )
  }
}

export function insertAdjacentElement(element: Node, where: string, inserted: Element): Element | null {
  if (!(inserted instanceof Element)) {
    throw new TypeError("Failed to execute 'insertAdjacentElement' on 'Element': parameter 2 is not of type 'Element'.")
  }
  const place = adjacentPlace(element, where)
  if (place === null) return null
  insertNode(place.parent, inserted, place.before)
  return inserted
}

export function insertAdjacentText(element: Node, where: string, data: string): void {
  const place = adjacentPlace(element, where)
  if (place === null) return
  insertNode(place.parent, parentBindingOf(place.parent).createText(String(data)), place.before)
}
