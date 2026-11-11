/**
 * `HTMLInputElement` and `HTMLTextAreaElement`, which a library reads off the window to tell a
 * text control from other elements (`target instanceof win.HTMLInputElement && target.type`).
 *
 * Ghia's host elements are all `HTMLElement`s, so these answer `instanceof` by the tag: an element
 * is an `HTMLInputElement` when it is an `<input>`. They cannot be constructed.
 */

import { HTMLElement } from "./nodes.js"

function illegalConstructor(): never {
  throw new TypeError("Illegal constructor")
}

abstract class HTMLInputElementClass extends HTMLElement {
  constructor() {
    super()
    illegalConstructor()
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof HTMLElement && value.localName === "input"
  }
}

abstract class HTMLTextAreaElementClass extends HTMLElement {
  constructor() {
    super()
    illegalConstructor()
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof HTMLElement && value.localName === "textarea"
  }
}

Object.defineProperty(HTMLInputElementClass, "name", { value: "HTMLInputElement" })
Object.defineProperty(HTMLTextAreaElementClass, "name", { value: "HTMLTextAreaElement" })

export const HTMLInputElement = HTMLInputElementClass
export type HTMLInputElement = HTMLInputElementClass
export const HTMLTextAreaElement = HTMLTextAreaElementClass
export type HTMLTextAreaElement = HTMLTextAreaElementClass
