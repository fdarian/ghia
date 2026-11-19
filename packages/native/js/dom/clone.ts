/**
 * `cloneNode`, written once over what an adapter's bindings give: a node of the same window
 * (`createElement`, `createText`), the props it was given and its live style. The clone is in no
 * tree and has no native element until it is inserted, and no framework owns it: what the
 * framework rendered into the original reaches the clone as it stood, and never again.
 */

import { isNotAttribute } from "./attribute-names.js"
import { inertDocumentOf } from "./html/inert-marker.js"
import { carryStyleMarks, styleAttributeText } from "./css-style-declaration.js"
import { DOM_BINDING, type DocumentFragment, type Element, type ElementBinding, type Node, type ParentBinding, type TextBinding } from "./nodes.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const COMMENT_NODE = 8
const DOCUMENT_FRAGMENT_NODE = 11

type PrimitiveProp = string | number | boolean

function isPrimitiveProp(value: unknown): value is PrimitiveProp {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function cloneElement(source: Element, deep: boolean): Element {
  const binding: ElementBinding = source[DOM_BINDING]()
  const clone = binding.createElement(binding.type)
  const cloneBinding: ElementBinding = clone[DOM_BINDING]()
  for (const name of binding.propNames()) {
    if (isNotAttribute(name)) continue
    // A handler, a ref, a `motion` or `layout` object and the style object are not attributes:
    // what is left is what `getAttribute` can read, with the types native was given.
    const value = binding.prop(name)
    if (isPrimitiveProp(value)) cloneBinding.setProp(name, value)
  }
  if (Object.keys(binding.style).length > 0 || styleAttributeText(binding.style) !== null) cloneBinding.setStyle(carryStyleMarks(binding.style, { ...binding.style }))
  if (deep) {
    for (const child of binding.children) cloneBinding.insertBefore(cloneNode(child, true), null)
  }
  // A template's content is not among its children, and only a parsed document's templates have any. A shallow clone keeps it empty.
  const content = Reflect.get(source, "templateContent") as DocumentFragment | undefined
  if (content !== undefined) Reflect.set(clone, "templateContent", cloneFragment(content, deep))
  return clone
}

function cloneText(source: Node): Node {
  const binding: TextBinding = source[DOM_BINDING]() as TextBinding
  return binding.createText(binding.data)
}

/** A comment exists only in a parsed document (a window's tree has no node for one), so its clone is made by that document. */
function cloneComment(source: Node): Node {
  const document = inertDocumentOf(source) as { createComment(data: string): Node } | undefined
  if (document === undefined) throw new Error("A comment that is not in a parsed document")
  return document.createComment((source[DOM_BINDING]() as TextBinding).data)
}

function cloneFragment(source: DocumentFragment, deep: boolean): Node {
  const binding: ParentBinding = source[DOM_BINDING]()
  const clone = binding.createFragment()
  if (deep) {
    const cloneBinding: ParentBinding = clone[DOM_BINDING]()
    for (const child of binding.children) cloneBinding.insertBefore(cloneNode(child, true), null)
  }
  return clone
}

export function cloneNode(source: Node, deep: boolean): Node {
  switch (source.nodeType) {
    case ELEMENT_NODE:
      return cloneElement(source as Element, deep)
    case TEXT_NODE:
      return cloneText(source)
    case COMMENT_NODE:
      return cloneComment(source)
    case DOCUMENT_FRAGMENT_NODE:
      return cloneFragment(source as DocumentFragment, deep)
    default:
      throw new DOMException(`cloneNode is not supported on a ${source.nodeName} node`, "NotSupportedError")
  }
}
