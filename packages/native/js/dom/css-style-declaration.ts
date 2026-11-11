/**
 * `element.style`: a `CSSStyleDeclaration` over the live `StyleDesc` of an element, so code writes
 * styles the way a browser's does (`el.style.setProperty("--x", "1")`, `el.style.translate = "..."`)
 * beside the styles a framework renders. The declaration holds no style of its own: it reads the
 * element's live style and hands a whole new `StyleDesc` back through the binding, which sends it
 * as a framework's own style change is sent.
 */

import type { StyleDesc } from "../host.js"
import { overlaps } from "../style-covers.js"
import { STYLE_PROPERTIES, type StyleProperty } from "../style-properties.js"

/** What an adapter gives the declaration of one of its elements. */
export type StyleBinding = {
  /** The style the element has now, the framework's and code's together. Never changed in place. */
  readonly style: StyleDesc
  /** Makes `next` the live style of the element and sends it. */
  setStyle(next: StyleDesc): void
}

type StyleRecord = Record<string, unknown>

/** The properties whose `StyleDesc` value is a number when the text is one; other text (`50%`, `auto`, `none`, `inherit`) goes to native as it is. */
const NUMBER_ONLY: ReadonlySet<string> = new Set(["flexGrow", "flexShrink", "order", "zIndex", "opacity", "lineClamp"])

/**
 * The properties a bare number is not a length for: the list native's `[style]` text uses
 * (`css/lenient.rs`, React DOM's own), so `getAttribute("style")` and a `[style]` selector read one text.
 */
const UNITLESS_NUMBER: ReadonlySet<string> = new Set([
  "animationIterationCount", "aspectRatio", "borderImageOutset", "borderImageSlice", "borderImageWidth",
  "columnCount", "columns", "flex", "flexGrow", "flexShrink", "fontWeight", "gridArea", "gridColumn",
  "gridColumnEnd", "gridColumnStart", "gridRow", "gridRowEnd", "gridRowStart", "lineClamp", "lineHeight",
  "opacity", "order", "orphans", "scale", "tabSize", "widows", "zIndex", "zoom",
  "fillOpacity", "floodOpacity", "stopOpacity", "strokeDasharray", "strokeDashoffset", "strokeMiterlimit",
  "strokeOpacity", "strokeWidth",
])

/** The properties whose bare number is degrees, as `StyleDesc` reads it (`DEGREES` in `css/lenient.rs`). */
const DEGREES: ReadonlySet<string> = new Set(["rotate", "motionRotate", "rotateX", "rotateY", "rotateZ", "skew", "skewX", "skewY"])

const IMPORTANT = /!\s*important\s*$/i

/**
 * A property written with `important` is held as its value and this suffix, the form a framework
 * writes one in (`display: "none !important"`) and the one native's cascade reads
 * (`css/inline_important.rs`). Every read takes it off again.
 */
const IMPORTANT_SUFFIX = " !important"
const IMPORTANT_TAIL = /\s*!\s*important\s*$/i

function plainText(text: string): string {
  return text.replace(IMPORTANT_TAIL, "")
}

function priorityOf(text: string): string {
  return IMPORTANT_TAIL.test(text) ? "important" : ""
}

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

/** The text of a value as native's `[style]` text has it: no text for `null` or `""`, `px` (`deg` on an angle) on a number, `0` for zero. */
function valueText(key: string, value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value
  if (typeof value !== "number") return undefined
  if (isCustom(key) || UNITLESS_NUMBER.has(key)) return String(value)
  if (value === 0) return "0"
  return DEGREES.has(key) ? `${value}deg` : `${value}px`
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
  for (const [name, value] of declarationsOf(style)) {
    text += `${text === "" ? "" : " "}${name}: ${plainText(value)}${priorityOf(value) === "" ? "" : IMPORTANT_SUFFIX};`
  }
  return text
}

const NUMERIC_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/** What a declaration's value is in a `StyleDesc`: a number for numeric text on a number property, else the text for native to judge. */
function storedValue(key: string, text: string): string | number {
  if (!isCustom(key) && NUMBER_ONLY.has(key) && NUMERIC_TEXT.test(text)) return Number(text)
  return text
}

/** The `name`, `value` and importance of each declaration of a declaration list; a part that is no declaration is dropped, as CSS does. */
function parseDeclarations(cssText: string): Array<[string, string, boolean]> {
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

  const declarations: Array<[string, string, boolean]> = []
  for (const declaration of parts) {
    const colon = findColon(declaration)
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim()
    const rawValue = declaration.slice(colon + 1)
    const value = rawValue.replace(IMPORTANT, "").trim()
    if (name === "" || value === "") continue
    declarations.push([name, value, IMPORTANT.test(rawValue)])
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
 * Sets the declaration of `key` to `stored` in `style`, and says whether that changed anything. A
 * declaration is replaced where it stands, as CSS does, unless a later one overlaps it (a shorthand
 * and a longhand it covers), where the last wins: then it moves last.
 */
function declare(style: StyleRecord, key: string, stored: unknown): boolean {
  const keys = Object.keys(style)
  const index = style[key] === undefined ? -1 : keys.indexOf(key)
  const inPlace = index >= 0 && !keys.slice(index + 1).some((later) => style[later] !== undefined && overlaps(key, later))
  if (inPlace && sameValue(style[key], stored)) return false
  if (!inPlace) delete style[key]
  style[key] = stored
  return true
}

/**
 * `live` with a framework's change from `previous` to `next` applied: what `next` set or changed
 * is written over code's, what `previous` had and `next` does not is removed, and every other
 * property keeps what the live style holds, code's included. What `next` set or changed is replaced
 * where it stands, and moves last when a later property overlaps it, because the last of a shorthand
 * and a longhand wins.
 */
export function applyStyleChange(live: StyleDesc, previous: StyleDesc, next: StyleDesc): StyleDesc {
  const result = { ...live } as StyleRecord
  const before = previous as StyleRecord
  const after = next as StyleRecord
  for (const key of Object.keys(after)) {
    const value = after[key]
    if (sameValue(before[key], value)) continue
    if (value === undefined) delete result[key]
    else declare(result, key, value)
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
    return plainText(valueText(key, (this.#binding.style as StyleRecord)[key]) ?? "")
  }

  /** `"important"` for a property written with that priority, else `""`. */
  getPropertyPriority(name: string): string {
    const key = keyOf(name)
    if (key === undefined) return ""
    return priorityOf(valueText(key, (this.#binding.style as StyleRecord)[key]) ?? "")
  }

  /**
   * Sets the property, or removes it for `""` and `null`. A property Ghia has no style for and a
   * value with `!important` change nothing, as in a browser; `priority` `"important"` stores the
   * value with the `!important` suffix. A value that is not valid CSS is stored as text, and native
   * drops it when it reads the style.
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
    const important = priority !== undefined && String(priority).toLowerCase() === "important"
    if (priority !== undefined && priority !== "" && !important) return
    const stored = important ? `${text}${IMPORTANT_SUFFIX}` : storedValue(key, text)
    const next = { ...this.#binding.style } as StyleRecord
    // The same text is no change even where the framework wrote it as a number (`width: 40` and `"40px"`).
    const held = next[key]
    const unchanged = held !== undefined && valueText(key, held) === valueText(key, stored)
    if (declare(next, key, unchanged ? held : stored)) this.#binding.setStyle(next as StyleDesc)
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
    return plainText(old)
  }

  item(index: number): string {
    return declarationsOf(this.#binding.style)[index]?.[0] ?? ""
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const declaration of declarationsOf(this.#binding.style)) yield declaration[0]
  }

  #declared(text: string): StyleRecord {
    const declared: StyleRecord = {}
    for (const [name, value, important] of parseDeclarations(text)) {
      const key = keyOf(name)
      if (key === undefined) continue
      delete declared[key]
      declared[key] = important ? `${value}${IMPORTANT_SUFFIX}` : storedValue(key, value)
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
