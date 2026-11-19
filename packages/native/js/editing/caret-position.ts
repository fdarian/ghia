/** `CaretPosition`: what `document.caretPositionFromPoint()` answers with, a place in a Text node. */

import type { DOMRect } from "../dom/dom-rect.js"
import type { Text } from "../dom/nodes.js"
import { caretRect } from "./geometry.js"

const CREATE = Symbol.for("@ghia/native/caret-position-create")

abstract class CaretPositionClass {
  readonly #node: Text
  readonly #offset: number

  constructor(token: symbol, node: Text, offset: number) {
    if (token !== CREATE) throw new TypeError("Illegal constructor")
    this.#node = node
    this.#offset = offset
  }

  get offsetNode(): Text {
    return this.#node
  }

  get offset(): number {
    return this.#offset
  }

  /** The rect of the caret there, as `Range.getClientRects()` gives it for the collapsed range: no width, the height of the font. `null` when the text did not paint. */
  getClientRect(): DOMRect | null {
    return caretRect({ node: this.#node, offset: this.#offset })
  }
}

Object.defineProperty(CaretPositionClass.prototype, Symbol.toStringTag, { value: "CaretPosition", configurable: true })

const CARET_POSITION_KEY = Symbol.for("@ghia/native/caret-position")

/** On `globalThis` like the DOM classes: a position from another copy of this package must pass `instanceof`. */
const shared: typeof CaretPositionClass = (() => {
  const existing = Reflect.get(globalThis, CARET_POSITION_KEY) as typeof CaretPositionClass | undefined
  if (existing) return existing
  Object.defineProperty(CaretPositionClass, "name", { value: "CaretPosition" })
  Reflect.set(globalThis, CARET_POSITION_KEY, CaretPositionClass)
  return CaretPositionClass
})()

export const CaretPosition = shared
export type CaretPosition = CaretPositionClass

export function createCaretPosition(node: Text, offset: number): CaretPosition {
  const Concrete = shared as unknown as new (token: symbol, node: Text, offset: number) => CaretPosition
  return new Concrete(CREATE, node, offset)
}
