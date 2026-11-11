/**
 * `element.style`: a `CSSStyleDeclaration` over the live `StyleDesc` of an element, so code writes
 * styles the way a browser's does (`el.style.setProperty("--x", "1")`, `el.style.translate = "..."`)
 * beside the styles a framework renders. The declaration holds no style of its own: it reads the
 * element's live style and hands a whole new `StyleDesc` back through the binding, which sends it
 * as a framework's own style change is sent.
 */

import type { StyleDesc } from "../host.js"
import { STYLE_PROPERTIES, type StyleProperty } from "../style-properties.js"

/** What an adapter gives the declaration of one of its elements. */
export type StyleBinding = {
  /** The style the element has now, the framework's and code's together. Never changed in place. */
  readonly style: StyleDesc
  /** Makes `next` the live style of the element and sends it. */
  setStyle(next: StyleDesc): void
}

type StyleRecord = Record<string, unknown>

/** The properties whose `StyleDesc` value is a number only: native does not read their text. */
const NUMBER_ONLY: ReadonlySet<string> = new Set(["flexGrow", "flexShrink", "order", "zIndex", "opacity", "lineClamp"])

/** The properties a bare number is not a length for. Any other number is px. */
const UNITLESS_NUMBER: ReadonlySet<string> = new Set([
  ...NUMBER_ONLY,
  "flex",
  "fontWeight",
  "lineHeight",
  "scale",
  "aspectRatio",
  "tabSize",
  "gridColumn",
  "gridRow",
  "gridColumnStart",
  "gridColumnEnd",
  "gridRowStart",
  "gridRowEnd",
  "gridArea",
  "gridTemplateColumns",
  "gridTemplateRows",
])

const IMPORTANT = /!\s*important\s*$/i

function kebabOf(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

const PROPERTY_BY_NAME: ReadonlyMap<string, StyleProperty> = new Map(
  (Object.keys(STYLE_PROPERTIES) as StyleProperty[]).map((property) => [kebabOf(property), property])
)

function isStyleProperty(key: string): key is StyleProperty {
  return Object.hasOwn(STYLE_PROPERTIES, key)
}

function isCustom(name: string): boolean {
  return name.startsWith("--")
}

/** The `StyleDesc` key a CSS property name is, or `undefined` for a property Ghia has no style for. */
function keyOf(name: string): string | undefined {
  const text = String(name)
  if (isCustom(text)) return text
  return PROPERTY_BY_NAME.get(text.toLowerCase())
}

/** The CSS name of a `StyleDesc` key, or `undefined` for a key that is not one declaration. */
function nameOf(key: string): string | undefined {
  if (isCustom(key)) return key
  return isStyleProperty(key) ? kebabOf(key) : undefined
}

function valueText(key: string, value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value !== "number") return undefined
  if (isCustom(key) || UNITLESS_NUMBER.has(key)) return String(value)
  if (key === "rotate") return `${value}deg`
  return `${value}px`
}

/** The declarations a style holds, as CSS names and texts, in written order. */
function declarationsOf(style: StyleDesc): Array<[string, string]> {
  const declarations: Array<[string, string]> = []
  const record = style as StyleRecord
  for (const key of Object.keys(record)) {
    const name = nameOf(key)
    if (name === undefined) continue
    const text = valueText(key, record[key])
    if (text !== undefined) declarations.push([name, text])
  }
  return declarations
}

/** `a: b; --c: d;`, as Chrome writes `cssText`. Empty for a style with no declaration. */
export function serializeStyle(style: StyleDesc): string {
  let text = ""
  for (const [name, value] of declarationsOf(style)) text += `${text === "" ? "" : " "}${name}: ${value};`
  return text
}

/** What a declaration's value is in a `StyleDesc`, or `undefined` for a value CSS would drop. */
function storedValue(key: string, text: string): string | number | undefined {
  if (!isCustom(key) && NUMBER_ONLY.has(key)) {
    const number = Number(text)
    return Number.isFinite(number) ? number : undefined
  }
  return text
}

/** The `name: value` pairs of a declaration list; a part that is no declaration is dropped, as CSS does. */
function parseDeclarations(cssText: string): Array<[string, string]> {
  const parts: string[] = []
  let part = ""
  let depth = 0
  let quote = ""
  for (let index = 0; index < cssText.length; index += 1) {
    const char = cssText[index]
    if (quote !== "") {
      part += char
      if (char === "\\") {
        index += 1
        part += cssText[index] ?? ""
      } else if (char === quote) quote = ""
      continue
    }
    if (char === "/" && cssText[index + 1] === "*") {
      const end = cssText.indexOf("*/", index + 2)
      index = end < 0 ? cssText.length : end + 1
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(") depth += 1
    else if (char === ")") depth = Math.max(0, depth - 1)
    if (char === ";" && depth === 0) {
      parts.push(part)
      part = ""
      continue
    }
    part += char
  }
  parts.push(part)

  const declarations: Array<[string, string]> = []
  for (const declaration of parts) {
    const colon = findColon(declaration)
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim()
    const value = declaration.slice(colon + 1).replace(IMPORTANT, "").trim()
    if (name === "" || value === "") continue
    declarations.push([name, value])
  }
  return declarations
}

function findColon(declaration: string): number {
  let depth = 0
  let quote = ""
  for (let index = 0; index < declaration.length; index += 1) {
    const char = declaration[index]
    if (quote !== "") {
      if (char === "\\") index += 1
      else if (char === quote) quote = ""
    } else if (char === '"' || char === "'") quote = char
    else if (char === "(") depth += 1
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if (char === ":" && depth === 0) return index
  }
  return -1
}

/** Equal as the JSON native is sent: a state block a framework rebuilds on every render is not a change. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  const leftRecord = left as StyleRecord
  const rightRecord = right as StyleRecord
  const keys = Object.keys(leftRecord)
  if (keys.length !== Object.keys(rightRecord).length) return false
  return keys.every((key) => sameValue(leftRecord[key], rightRecord[key]))
}

/**
 * `live` with a framework's change from `previous` to `next` applied: what `next` set or changed
 * is written over code's, what `previous` had and `next` does not is removed, and every other
 * property keeps what the live style holds, code's included. A property already in `live` keeps
 * its place, because a shorthand written after a longhand covers it.
 */
export function applyStyleChange(live: StyleDesc, previous: StyleDesc, next: StyleDesc): StyleDesc {
  const result = { ...live } as StyleRecord
  const before = previous as StyleRecord
  const after = next as StyleRecord
  for (const key of Object.keys(after)) {
    const value = after[key]
    if (sameValue(before[key], value)) continue
    if (value === undefined) delete result[key]
    else result[key] = value
  }
  for (const key of Object.keys(before)) if (!(key in after)) delete result[key]
  return result as StyleDesc
}

function illegalConstructor(): never {
  throw new TypeError("Illegal constructor")
}

type StyleDeclarationSet = {
  CSSStyleDeclaration: typeof CSSStyleDeclarationClass
  styleDeclarationFor(owner: object, binding: StyleBinding): CSSStyleDeclaration
}

const CONSTRUCT = Symbol("construct")

class CSSStyleDeclarationClass {
  readonly #binding: StyleBinding

  constructor(binding: StyleBinding, token?: typeof CONSTRUCT) {
    if (token !== CONSTRUCT) illegalConstructor()
    this.#binding = binding
  }

  get length(): number {
    return declarationsOf(this.#binding.style).length
  }

  get cssText(): string {
    return serializeStyle(this.#binding.style)
  }

  /** Replaces every declaration; the state blocks and queries a style holds are not CSS text and stay. */
  set cssText(text: string) {
    const kept: StyleRecord = {}
    const live = this.#binding.style as StyleRecord
    for (const key of Object.keys(live)) if (nameOf(key) === undefined) kept[key] = live[key]
    this.#binding.setStyle({ ...kept, ...this.#declared(String(text)) } as StyleDesc)
  }

  get parentRule(): null {
    return null
  }

  getPropertyValue(name: string): string {
    const key = keyOf(name)
    if (key === undefined) return ""
    return valueText(key, (this.#binding.style as StyleRecord)[key]) ?? ""
  }

  /** Always `""`: a style has no per-property priority here (deviations.md). */
  getPropertyPriority(_name: string): string {
    return ""
  }

  /**
   * Sets the property, or removes it for `""` and `null`. A property Ghia has no style for, a value
   * CSS would not accept and a value with `!important` change nothing, as in a browser; `priority`
   * is accepted and ignored.
   */
  setProperty(name: string, value: string | null, priority?: string): void {
    const key = keyOf(name)
    if (key === undefined) return
    const text = value === null || value === undefined ? "" : String(value).trim()
    if (text === "") {
      this.removeProperty(name)
      return
    }
    if (IMPORTANT.test(text)) return
    if (priority !== undefined && priority !== "" && String(priority).toLowerCase() !== "important") return
    const stored = storedValue(key, text)
    if (stored === undefined) return
    const live = this.#binding.style as StyleRecord
    if (live[key] === stored) return
    // Written last, as in CSS: the last of a shorthand and a longhand wins.
    const next = { ...live }
    delete next[key]
    next[key] = stored
    this.#binding.setStyle(next as StyleDesc)
  }

  /** The value the property had, `""` when it had none. */
  removeProperty(name: string): string {
    const key = keyOf(name)
    if (key === undefined) return ""
    const live = this.#binding.style as StyleRecord
    const old = valueText(key, live[key])
    if (old === undefined) return ""
    const next = { ...live }
    delete next[key]
    this.#binding.setStyle(next as StyleDesc)
    return old
  }

  item(index: number): string {
    return declarationsOf(this.#binding.style)[index]?.[0] ?? ""
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const declaration of declarationsOf(this.#binding.style)) yield declaration[0]
  }

  #declared(text: string): StyleRecord {
    const declared: StyleRecord = {}
    for (const [name, value] of parseDeclarations(text)) {
      const key = keyOf(name)
      if (key === undefined) continue
      const stored = storedValue(key, value)
      if (stored === undefined) continue
      delete declared[key]
      declared[key] = stored
    }
    return declared
  }
}

for (const property of Object.keys(STYLE_PROPERTIES)) {
  const name = kebabOf(property)
  Object.defineProperty(CSSStyleDeclarationClass.prototype, property, {
    enumerable: true,
    configurable: true,
    get(this: CSSStyleDeclarationClass) {
      return this.getPropertyValue(name)
    },
    set(this: CSSStyleDeclarationClass, value: string | number | null) {
      this.setProperty(name, value === null ? "" : String(value))
    },
  })
}

export type CSSStyleDeclaration = CSSStyleDeclarationClass & { [Property in StyleProperty]: string }

const STYLE_DECLARATION_KEY = Symbol.for("@ghia/native/css-style-declaration")

/**
 * Kept on `globalThis` like the DOM classes: a second copy of this package must share the class,
 * so `style instanceof CSSStyleDeclaration` holds across copies, and the one cache of declarations.
 */
const shared: StyleDeclarationSet = (() => {
  const existing = Reflect.get(globalThis, STYLE_DECLARATION_KEY) as StyleDeclarationSet | undefined
  if (existing) return existing
  Object.defineProperty(CSSStyleDeclarationClass, "name", { value: "CSSStyleDeclaration" })
  const declarations = new WeakMap<object, CSSStyleDeclaration>()
  const created: StyleDeclarationSet = {
    CSSStyleDeclaration: CSSStyleDeclarationClass,
    styleDeclarationFor(owner, binding) {
      const known = declarations.get(owner)
      if (known !== undefined) return known
      const declaration = new CSSStyleDeclarationClass(binding, CONSTRUCT) as CSSStyleDeclaration
      declarations.set(owner, declaration)
      return declaration
    },
  }
  Reflect.set(globalThis, STYLE_DECLARATION_KEY, created)
  return created
})()

export const CSSStyleDeclaration = shared.CSSStyleDeclaration

/** The declaration of `owner`, made on the first call and kept: an element nothing reads `style` of has none. */
export const styleDeclarationFor = shared.styleDeclarationFor
