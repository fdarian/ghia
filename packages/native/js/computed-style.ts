import { HOST_BINDING, flushPendingMutations, type ObservableElement } from "./bounds.js"
import type { NativeRenderer } from "./host.js"
import { appliedBatchCount } from "./mutations.js"

/**
 * The properties `getComputedStyle` answers, in kebab case: the ones that web libraries read (drag and
 * drop, popovers, virtualisers, base UI). Any other name reads as `""`.
 */
export const COMPUTED_STYLE_PROPERTIES = [
  "display",
  "position",
  "visibility",
  "overflow",
  "overflow-x",
  "overflow-y",
  "direction",
  "writing-mode",
  "box-sizing",
  "will-change",
  "contain",
  "scrollbar-gutter",
  "content",
  "z-index",
  "filter",
  "backdrop-filter",
  "transform",
  "transform-origin",
  "translate",
  "rotate",
  "scale",
  "perspective",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  ...sides("padding", ""),
  ...sides("margin", ""),
  ...sides("border", "-width"),
  ...sides("scroll-margin", ""),
  ...sides("scroll-padding", ""),
  "transition",
  "transition-property",
  "transition-duration",
  "transition-delay",
  "transition-timing-function",
  "animation-name",
  "animation-duration",
  "font-size",
  "color",
  "opacity",
  "background-color",
] as const

function sides<Prefix extends string, Suffix extends string>(prefix: Prefix, suffix: Suffix) {
  return [
    `${prefix}-top${suffix}`,
    `${prefix}-right${suffix}`,
    `${prefix}-bottom${suffix}`,
    `${prefix}-left${suffix}`,
    `${prefix}-inline-start${suffix}`,
    `${prefix}-inline-end${suffix}`,
    `${prefix}-block-start${suffix}`,
    `${prefix}-block-end${suffix}`,
  ] as const
}

type KebabToCamel<Name extends string> = Name extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
  : Name

/** The camelCase members of a computed style: one string for each of `COMPUTED_STYLE_PROPERTIES`. */
export type ComputedStyleProperties = {
  readonly [Name in (typeof COMPUTED_STYLE_PROPERTIES)[number] as KebabToCamel<Name>]: string
}

/** A `CSSStyleDeclaration` that is read only, like the one `getComputedStyle` returns. */
export interface ComputedStyle extends ComputedStyleProperties {
  readonly length: number
  readonly cssText: string
  readonly parentRule: null
  getPropertyValue(name: string): string
  getPropertyPriority(name: string): string
  item(index: number): string
  setProperty(name: string, value: string | null, priority?: string): never
  removeProperty(name: string): never
  [Symbol.iterator](): Iterator<string>
}

type Values = ReadonlyMap<string, string>

type Cached = {
  /** Batches of mutations applied when it was read: one more and the record may be stale. */
  batches: number
  values: Values | undefined
}

let turnEnds = false
// Per renderer, so that a burst of getters (`style.width`, then `style.height`) is one native read.
const cache = new WeakMap<object, Map<string, Cached>>()
// Native state moves on between turns without a batch, so an entry is only valid for the turn it
// was read in; the maps filled this turn are emptied when it ends, or every element ever read
// would keep an entry.
const filledThisTurn = new Set<Map<string, Cached>>()

function endTurnLater(): void {
  if (turnEnds) return
  turnEnds = true
  queueMicrotask(() => {
    for (const records of filledThisTurn) records.clear()
    filledThisTurn.clear()
    turnEnds = false
  })
}

function pairsToValues(pairs: readonly string[]): Values {
  const values = new Map<string, string>()
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    const name = pairs[index]
    const value = pairs[index + 1]
    if (name === undefined || value === undefined) throw new Error("The native computed style is not name and value pairs")
    values.set(name, value)
  }
  return values
}

/**
 * Asks native for the computed style of element `id`, laying the window out first like
 * `getBoundingClientRect`. `undefined` while the element is not in the document. `pseudo` reads the
 * `::before` or `::after` of an element, which Ghia has none of.
 *
 * The answer is kept until a batch of mutations reaches the renderer or the current turn of the
 * event loop ends, so reading ten properties costs one call and a read after a write is fresh.
 */
export function readComputedStyle(
  renderer: NativeRenderer,
  id: number,
  pseudo: boolean
): Values | undefined {
  if (!renderer.getComputedStyle) {
    throw new Error("This renderer cannot read computed styles: it has no getComputedStyle")
  }
  flushPendingMutations(renderer)
  const key = `${id}${pseudo ? ":" : ""}`
  let records = cache.get(renderer)
  if (!records) {
    records = new Map()
    cache.set(renderer, records)
  }
  const batches = appliedBatchCount()
  const kept = records.get(key)
  if (kept && kept.batches === batches) return kept.values
  const pairs = renderer.getComputedStyle(id, pseudo)
  const values = pairs ? pairsToValues(pairs) : undefined
  records.set(key, { batches, values })
  filledThisTurn.add(records)
  endTurnLater()
  return values
}

function modificationNotAllowed(message: string): Error {
  if (typeof DOMException === "function") return new DOMException(message, "NoModificationAllowedError")
  return Object.assign(new Error(message), { name: "NoModificationAllowedError", code: 7 })
}

function readOnly(method: string, property: string): never {
  throw modificationNotAllowed(
    `Failed to execute '${method}' on 'CSSStyleDeclaration': These styles are computed, and therefore the '${property}' property is read-only.`
  )
}

const KNOWN: ReadonlySet<string> = new Set(COMPUTED_STYLE_PROPERTIES)

class ComputedStyleDeclaration {
  readonly #element: ObservableElement
  readonly #pseudo: "none" | "absent" | "unsupported"

  constructor(element: ObservableElement, pseudo: "none" | "absent" | "unsupported") {
    this.#element = element
    this.#pseudo = pseudo
  }

  #values(): Values | undefined {
    if (this.#pseudo === "unsupported") return undefined
    const binding = this.#element[HOST_BINDING]()
    if (!binding) return undefined
    return readComputedStyle(binding.renderer, this.#element.nativeId, this.#pseudo === "absent")
  }

  get length(): number {
    return COMPUTED_STYLE_PROPERTIES.length
  }

  get cssText(): string {
    return ""
  }

  get parentRule(): null {
    return null
  }

  getPropertyValue(name: string): string {
    const property = name.startsWith("--") ? name : String(name).toLowerCase()
    if (!KNOWN.has(property) && !property.startsWith("--")) return ""
    const value = this.#values()?.get(property)
    return value === undefined ? "" : value
  }

  getPropertyPriority(_name: string): string {
    return ""
  }

  item(index: number): string {
    const name = COMPUTED_STYLE_PROPERTIES[index]
    return name === undefined ? "" : name
  }

  setProperty(name: string): never {
    return readOnly("setProperty", name)
  }

  removeProperty(name: string): never {
    return readOnly("removeProperty", name)
  }

  [Symbol.iterator](): Iterator<string> {
    return COMPUTED_STYLE_PROPERTIES[Symbol.iterator]()
  }
}

function camelCase(property: string): string {
  return property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

for (const property of COMPUTED_STYLE_PROPERTIES) {
  Object.defineProperty(ComputedStyleDeclaration.prototype, camelCase(property), {
    enumerable: true,
    configurable: true,
    get(this: ComputedStyleDeclaration) {
      return this.getPropertyValue(property)
    },
    set(this: ComputedStyleDeclaration, _value: string) {
      readOnly("setter", property)
    },
  })
}

const PSEUDO_ABSENT = /^::?(before|after)$/

/**
 * `window.getComputedStyle`: the resolved values of an element, as Chrome reports them for the
 * properties in `COMPUTED_STYLE_PROPERTIES`, camelCase members and `getPropertyValue(kebab-case)`,
 * custom properties (`--name`) included. The object is live: each read asks native again, and an
 * element that is not in the document reads `""` for everything.
 *
 * `pseudoElt` `::before` and `::after` give what Chrome reports for a pseudo-element that does not
 * exist (Ghia has none): `content` is `none` and `width` and `height` are `auto`. Any other pseudo
 * reads `""`.
 */
export function getComputedStyle(element: ObservableElement, pseudoElt?: string | null): ComputedStyle {
  if (typeof element !== "object" || element === null || typeof element[HOST_BINDING] !== "function") {
    throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.")
  }
  const pseudo =
    pseudoElt === undefined || pseudoElt === null || pseudoElt === ""
      ? "none"
      : PSEUDO_ABSENT.test(pseudoElt)
        ? "absent"
        : "unsupported"
  return new ComputedStyleDeclaration(element, pseudo) as unknown as ComputedStyle
}
