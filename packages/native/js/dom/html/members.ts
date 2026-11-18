/**
 * `innerHTML`, `outerHTML` and `insertAdjacentHTML` of an element. Markup is parsed in the context
 * of the element as a browser does (`parse.ts`), into nodes of a parsed document, and then made
 * again as nodes of the element's own document through its binding, so they are drawn when the
 * element is in a window.
 */

import { isElementType } from "../element-types.js"
import { insertAdjacentNode } from "../tree-mutation.js"
import { DOM_BINDING, type DocumentFragment, type Element, type Node, type ParentBinding } from "../nodes.js"
import { InertDocument, InertElement } from "./inert-nodes.js"
import { inertDocumentOf } from "./inert-marker.js"
import { parseHtmlFragment, serializeChildren, serializeNode } from "./parse.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const DOCUMENT_NODE = 9

function childrenOf(node: Node): readonly Node[] {
  return node[DOM_BINDING]().children
}

/** `source`, made again by `binding`'s owner; `drawn` is whether that is a window's node. A comment has no node in a window, so it is left out. */
function importNode(binding: ParentBinding, source: Node, drawn: boolean): Node | null {
  if (source.nodeType === TEXT_NODE) return binding.createText(source.textContent ?? "")
  if (source.nodeType !== ELEMENT_NODE) return null
  const original = source as Element
  const type = original.localName
  if (drawn && !isElementType(type)) {
    throw new DOMException(`<${type}> is not an element Ghia draws, so markup with it cannot be set.`, "NotSupportedError")
  }
  const element = binding.createElement(type)
  for (const name of original.getAttributeNames()) {
    const text = original.getAttribute(name)
    if (text === null) throw new Error(`The attribute "${name}" is listed and has no text`)
    element.setAttribute(name, text)
  }
  const into = element[DOM_BINDING]() as ParentBinding
  for (const child of childrenOf(original)) {
    const imported = importNode(into, child, drawn)
    if (imported !== null) into.insertBefore(imported, null)
  }
  const content = (original as unknown as InertElement).templateContent
  if (content !== undefined) {
    const copy = into.createFragment()
    const copyBinding = copy[DOM_BINDING]() as ParentBinding
    for (const child of childrenOf(content as unknown as Node)) {
      const imported = importNode(copyBinding, child, drawn)
      if (imported !== null) copyBinding.insertBefore(imported, null)
    }
    ;(element as unknown as InertElement).templateContent = copy as never
  }
  return element
}

/** The nodes `markup` makes in the context of `context`, as nodes of `target`'s document in a fragment. */
function markupFragment(target: Node, context: Element, markup: string): DocumentFragment {
  const parsed = parseHtmlFragment(context, markup)
  const binding = target[DOM_BINDING]() as ParentBinding
  const drawn = inertDocumentOf(target) === undefined
  const fragment = binding.createFragment()
  const into = fragment[DOM_BINDING]() as ParentBinding
  for (const child of childrenOf(parsed as unknown as Node)) {
    const imported = importNode(binding, child, drawn)
    if (imported !== null) into.insertBefore(imported, null)
  }
  return fragment
}

/** The element the HTML spec parses in when markup is set beside `parent`: a fragment's is a `<body>`. */
function contextFor(parent: Node | null): Element {
  if (parent === null || parent.nodeType === DOCUMENT_NODE) {
    throw new DOMException("The element has no parent element to parse the markup in", "NoModificationAllowedError")
  }
  if (parent.nodeType === ELEMENT_NODE) return parent as Element
  return new InertDocument().createElement("body")
}

function markupText(value: unknown): string {
  return value === null ? "" : String(value)
}

/** Defines the members on `prototype`, the one of `Element`. */
export function defineHtmlMembers(prototype: object): void {
  Object.defineProperties(prototype, {
    innerHTML: {
      configurable: true,
      get(this: Element) {
        return serializeChildren(this)
      },
      set(this: Element, value: unknown) {
        this.replaceChildren(markupFragment(this, this, markupText(value)))
      },
    },
    outerHTML: {
      configurable: true,
      get(this: Element) {
        return serializeNode(this)
      },
      set(this: Element, value: unknown) {
        const parent = this.parentNode
        if (parent === null) return
        this.replaceWith(markupFragment(parent, contextFor(parent), markupText(value)))
      },
    },
    insertAdjacentHTML: {
      configurable: true,
      writable: true,
      value(this: Element, where: string, markup: string) {
        insertAdjacentNode(this, String(where), (parent) => markupFragment(parent, contextFor(parent), String(markup)))
      },
    },
  })
}
