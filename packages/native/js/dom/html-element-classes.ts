/**
 * `HTMLInputElement`, `HTMLTextAreaElement` and `HTMLButtonElement`, which a library reads off the
 * window to tell a text control or a button from other elements (`target instanceof win.HTMLInputElement
 * && target.type`, `element instanceof HTMLButtonElement`).
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

abstract class HTMLButtonElementClass extends HTMLElement {
  constructor() {
    super()
    illegalConstructor()
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof HTMLElement && value.localName === "button"
  }
}

Object.defineProperty(HTMLInputElementClass, "name", { value: "HTMLInputElement" })
Object.defineProperty(HTMLTextAreaElementClass, "name", { value: "HTMLTextAreaElement" })
Object.defineProperty(HTMLButtonElementClass, "name", { value: "HTMLButtonElement" })

export const HTMLInputElement = HTMLInputElementClass
export type HTMLInputElement = HTMLInputElementClass
export const HTMLTextAreaElement = HTMLTextAreaElementClass
export type HTMLTextAreaElement = HTMLTextAreaElementClass
export const HTMLButtonElement = HTMLButtonElementClass
export type HTMLButtonElement = HTMLButtonElementClass
