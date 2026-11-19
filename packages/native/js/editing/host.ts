/**
 * Which elements are editable and which are editing hosts, from the `contenteditable` attribute as
 * the HTML standard reads it: an element's own value is `true`, `false` or `plaintext-only` (an empty
 * text is `true`, the keywords are ASCII case-insensitive) or it has none, and then it takes its
 * parent's. Native keeps the same rule for focus and `:read-write` (`html/editing.rs`).
 */

import type { Element, Node } from "../dom/nodes.js"

const ELEMENT_NODE = 1

export type ContentEditableKeyword = "true" | "false" | "plaintext-only"

/** The keyword a text spells (ASCII case-insensitive), or `undefined` for any other text. */
export function contentEditableKeyword(text: string): ContentEditableKeyword | undefined {
  switch (text.toLowerCase()) {
    case "true":
      return "true"
    case "false":
      return "false"
    case "plaintext-only":
      return "plaintext-only"
    default:
      return undefined
  }
}

/** The element's own `contenteditable` value: `undefined` for no attribute and for a text that is no keyword (it inherits). */
export function ownContentEditable(element: Element): ContentEditableKeyword | undefined {
  const text = element.getAttribute("contenteditable")
  if (text === null) return undefined
  return text === "" ? "true" : contentEditableKeyword(text)
}

function isElement(node: Node | null): node is Element {
  return node !== null && node.nodeType === ELEMENT_NODE
}

/** `node` if it is an element, else the closest element above it. */
function elementOf(node: Node): Element | null {
  let current: Node | null = node
  while (current !== null && !isElement(current)) current = current.parentNode
  return current
}

function parentElementOf(element: Element): Element | null {
  const parent = element.parentNode
  return isElement(parent) ? parent : null
}

function isEditable(keyword: ContentEditableKeyword): boolean {
  return keyword !== "false"
}

/** The value that decides `node`: its own, else the nearest ancestor's; `"false"` when no element up the tree has one. */
export function editableState(node: Node): ContentEditableKeyword {
  for (let element = elementOf(node); element !== null; element = parentElementOf(element)) {
    const own = ownContentEditable(element)
    if (own !== undefined) return own
  }
  return "false"
}

/** Whether the element is editable: `isContentEditable`. */
export function isContentEditable(element: Element): boolean {
  return isEditable(editableState(element))
}

/**
 * The outermost editable inclusive ancestor of `node` whose parent is not editable, or `null` when
 * `node` is not editable. A `contenteditable="false"` island inside a host is not editable, so an
 * editable element inside the island is a host of its own.
 */
export function editingHostOf(node: Node): Element | null {
  let host: Element | null = null
  for (let element = elementOf(node); element !== null; element = parentElementOf(element)) {
    const own = ownContentEditable(element)
    if (own === undefined) continue
    if (!isEditable(own)) return host
    host = element
  }
  return host
}

export function isEditingHost(element: Element): boolean {
  return editingHostOf(element) === element
}
