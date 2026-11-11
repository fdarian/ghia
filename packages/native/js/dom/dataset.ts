/**
 * `element.dataset`: the `data-*` attributes as a `DOMStringMap`, live. `dataset.rowId` is the
 * `data-row-id` attribute, and a write or a `delete` goes through `setAttribute` and
 * `removeAttribute`, so it reaches the prop and native as the attribute does. Base UI's focus
 * guards keep an element's `tabindex` in `dataset.tabindex` and put it back from there.
 */

import type { Element } from "./nodes.js"

const DATA_ATTRIBUTE = /^data-(.+)$/

function camelCase(dashed: string): string {
  return dashed.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/** The attribute a dataset name stands for; a name with a `-` before a lowercase letter has none, and the DOM throws for it on a write. */
function attributeOf(name: string, write: boolean): string | undefined {
  if (/-[a-z]/.test(name)) {
    if (write) throw new DOMException(`'${name}' is not a valid property name.`, "SyntaxError")
    return undefined
  }
  return `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}

function dataNames(element: Element): string[] {
  const names: string[] = []
  for (const attribute of element.getAttributeNames()) {
    const match = DATA_ATTRIBUTE.exec(attribute)
    if (match !== null) names.push(camelCase(match[1]))
  }
  return names
}

const views = new WeakMap<object, DOMStringMap>()

export function datasetOf(element: Element): DOMStringMap {
  const existing = views.get(element)
  if (existing !== undefined) return existing
  const created = new Proxy<DOMStringMap>(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined
        const attribute = attributeOf(key, false)
        const value = attribute === undefined ? null : element.getAttribute(attribute)
        return value === null ? undefined : value
      },
      set(_target, key, value) {
        if (typeof key !== "string") return false
        element.setAttribute(attributeOf(key, true) as string, String(value))
        return true
      },
      deleteProperty(_target, key) {
        if (typeof key !== "string") return true
        const attribute = attributeOf(key, false)
        if (attribute !== undefined) element.removeAttribute(attribute)
        return true
      },
      has(_target, key) {
        if (typeof key !== "string") return false
        const attribute = attributeOf(key, false)
        return attribute !== undefined && element.hasAttribute(attribute)
      },
      ownKeys() {
        return dataNames(element)
      },
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key !== "string") return undefined
        const attribute = attributeOf(key, false)
        const value = attribute === undefined ? null : element.getAttribute(attribute)
        return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true }
      },
    }
  )
  views.set(element, created)
  return created
}
