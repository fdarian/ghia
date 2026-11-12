/**
 * `cloneNode`, written once over what an adapter's bindings give: a node of the same window
 * (`createElement`, `createText`), the props it was given and its live style. The clone is in no
 * tree and has no native element until it is inserted, and no framework owns it: what the
 * framework rendered into the original reaches the clone as it stood, and never again.
 */

import { isNotAttribute } from "./attribute-names.js"
import { carryUnsupported, styleAttributeText } from "./css-style-declaration.js"
import { DOM_BINDING, type Element, type ElementBinding, type Node, type TextBinding } from "./nodes.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3

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
  if (Object.keys(binding.style).length > 0 || styleAttributeText(binding.style) !== null) cloneBinding.setStyle(carryUnsupported(binding.style, { ...binding.style }))
  if (deep) {
    for (const child of binding.children) cloneBinding.insertBefore(cloneNode(child, true), null)
  }
  return clone
}

function cloneText(source: Node): Node {
  const binding: TextBinding = source[DOM_BINDING]() as TextBinding
  return binding.createText(binding.data)
}

export function cloneNode(source: Node, deep: boolean): Node {
  switch (source.nodeType) {
    case ELEMENT_NODE:
      return cloneElement(source as Element, deep)
    case TEXT_NODE:
      return cloneText(source)
    default:
      throw new DOMException(`cloneNode is not supported on a ${source.nodeName} node`, "NotSupportedError")
  }
}
