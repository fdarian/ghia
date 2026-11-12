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
import { CSS_PROPERTY_NAMES } from "./css-property-names.js"

/** What an adapter gives the declaration of one of its elements. */
export type StyleBinding = {
  /** The style the element has now, the framework's and code's together. Never changed in place. */
  readonly style: StyleDesc
  /** Makes `next` the live style of the element and sends it. */
  setStyle(next: StyleDesc): void
}

type StyleRecord = Record<string, unknown>

/**
 * Where a style keeps what code wrote that Ghia has no style key for (`touch-action`): CSS names to
 * texts, with the `!important` suffix. It is a non-enumerable symbol key, so it is not in what
 * native is sent, in a walk of the style's properties or in a comparison of two styles. A spread
 * does not carry it either: `applyStyleChange` and `cloneNode` copy it with `withUnsupported`. A style that
 * has the key at all is a style code has written to: the `style` attribute is there, `""` when
 * nothing is left in it.
 */
const UNSUPPORTED = Symbol.for("@ghia/native/style-unsupported")

type Unsupported = Readonly<Record<string, string>>

function unsupportedOf(style: StyleDesc): Unsupported | undefined {
  return (style as unknown as { [UNSUPPORTED]?: Unsupported })[UNSUPPORTED]
}

/** `style` with `unsupported` set on it (a style that has none gets none), and the style itself. */
export function withUnsupported(style: StyleRecord, unsupported: Unsupported | undefined): StyleDesc {
  if (unsupported !== undefined) Object.defineProperty(style, UNSUPPORTED, { value: unsupported, configurable: true })
  return style as StyleDesc
}

/** What `applyStyleChange` and a clone copy of a style that a spread leaves behind. */
export function carryUnsupported(from: StyleDesc, to: StyleRecord): StyleDesc {
  return withUnsupported(to, unsupportedOf(from))
}

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

/** The lower-case name of a CSS property a browser has and Ghia has no style key for, or `undefined` for a name that is none. */
function unsupportedNameOf(name: string): string | undefined {
  const lower = String(name).toLowerCase()
  return !isCustom(lower) && !PROPERTY_BY_NAME.has(lower) && CSS_PROPERTY_NAMES.has(lower) ? lower : undefined
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
  const unsupported = unsupportedOf(style)
  if (unsupported !== undefined) declarations.push(...Object.entries(unsupported))
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

/** What `getAttribute("style")` gives: the text, `""` for a style code emptied, `null` for an element no style was ever written to. */
export function styleAttributeText(style: StyleDesc): string | null {
  const text = serializeStyle(style)
  return text === "" && unsupportedOf(style) === undefined ? null : text
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
  return carryUnsupported(live, result)
}

function illegalConstructor(): never {
  throw new TypeError("Illegal constructor")
}

type StyleDeclarationSet = {
  CSSStyleDeclaration: typeof CSSStyleDeclarationClass
  styleDeclarationFor(owner: object, binding: StyleBinding): CSSStyleDeclaration
}

const CONSTRUCT = Symbol("construct")

/** Replaces every declaration with those of `text`, or with none and no `style` attribute for `null`; the state blocks and queries a style holds are not CSS text and stay. */
export function writeStyleText(binding: StyleBinding, text: string | null): void {
  const kept: StyleRecord = {}
  const live = binding.style as StyleRecord
  for (const key of Object.keys(live)) if (nameOf(key) === undefined) kept[key] = live[key]
  if (text === null) {
    binding.setStyle(kept as StyleDesc)
    return
  }
  const declared: StyleRecord = {}
  const unsupported: Record<string, string> = {}
  for (const [name, value, important] of parseDeclarations(text)) {
    const key = keyOf(name)
    const stored = important ? `${value}${IMPORTANT_SUFFIX}` : undefined
    if (key !== undefined) {
      delete declared[key]
      declared[key] = stored ?? storedValue(key, value)
      continue
    }
    const unsupportedName = unsupportedNameOf(name)
    if (unsupportedName === undefined) continue
    delete unsupported[unsupportedName]
    unsupported[unsupportedName] = stored ?? value
  }
  binding.setStyle(withUnsupported({ ...kept, ...declared }, unsupported))
}

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

  set cssText(text: string) {
    writeStyleText(this.#binding, String(text))
  }

  get parentRule(): null {
    return null
  }

  getPropertyValue(name: string): string {
    return plainText(this.#textOf(name))
  }

  /** `"important"` for a property written with that priority, else `""`. */
  getPropertyPriority(name: string): string {
    return priorityOf(this.#textOf(name))
  }

  /**
   * Sets the property, or removes it for `""` and `null`. A name that is no CSS property and a
   * value with `!important` change nothing, as in a browser; `priority` `"important"` stores the
   * value with the `!important` suffix. A property a browser has and Ghia has no style key for
   * (`touch-action`) is kept and read back and reaches nothing. A value that is not valid CSS is
   * stored as text, and native drops it when it reads the style.
   */
  setProperty(name: string, value: string | null, priority?: string): void {
    const key = keyOf(name)
    const unsupported = key === undefined ? unsupportedNameOf(name) : undefined
    if (key === undefined && unsupported === undefined) return
    const text = value === null || value === undefined ? "" : String(value).trim()
    if (text === "") {
      this.removeProperty(name)
      return
    }
    if (IMPORTANT.test(text)) return
    const important = priority !== undefined && String(priority).toLowerCase() === "important"
    if (priority !== undefined && priority !== "" && !important) return
    const withPriority = important ? `${text}${IMPORTANT_SUFFIX}` : text
    if (key === undefined) {
      this.#declareUnsupported(unsupported as string, withPriority)
      return
    }
    const stored = important ? withPriority : storedValue(key, text)
    const next = { ...this.#binding.style } as StyleRecord
    // The same text is no change even where the framework wrote it as a number (`width: 40` and `"40px"`).
    const held = next[key]
    const unchanged = held !== undefined && valueText(key, held) === valueText(key, stored)
    if (declare(next, key, unchanged ? held : stored)) this.#commit(next)
  }

  /** The value the property had, `""` when it had none. */
  removeProperty(name: string): string {
    const key = keyOf(name)
    const live = this.#binding.style as StyleRecord
    if (key === undefined) return this.#removeUnsupported(name)
    const old = valueText(key, live[key])
    if (old === undefined) return ""
    const next = { ...live }
    delete next[key]
    this.#commit(next)
    return plainText(old)
  }

  item(index: number): string {
    return declarationsOf(this.#binding.style)[index]?.[0] ?? ""
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const declaration of declarationsOf(this.#binding.style)) yield declaration[0]
  }

  #textOf(name: string): string {
    const key = keyOf(name)
    if (key !== undefined) return valueText(key, (this.#binding.style as StyleRecord)[key]) ?? ""
    const unsupported = unsupportedNameOf(name)
    return unsupported === undefined ? "" : (unsupportedOf(this.#binding.style)?.[unsupported] ?? "")
  }

  #declareUnsupported(name: string, stored: string): void {
    const held = unsupportedOf(this.#binding.style)
    if (held?.[name] === stored) return
    this.#commit({ ...this.#binding.style } as StyleRecord, { ...held, [name]: stored })
  }

  #removeUnsupported(name: string): string {
    const unsupported = unsupportedNameOf(name)
    const held = unsupportedOf(this.#binding.style)
    const old = unsupported === undefined ? undefined : held?.[unsupported]
    if (unsupported === undefined || old === undefined) return ""
    const rest = { ...held }
    delete rest[unsupported]
    this.#commit({ ...this.#binding.style } as StyleRecord, rest)
    return plainText(old)
  }

  /** Hands `next` over as the live style; a write from code leaves the `style` attribute there, even when nothing is left in it. */
  #commit(next: StyleRecord, unsupported: Unsupported = unsupportedOf(this.#binding.style) ?? {}): void {
    this.#binding.setStyle(withUnsupported(next, unsupported))
  }
}

function defineAccessor(member: string, name: string): void {
  if (Object.hasOwn(CSSStyleDeclarationClass.prototype, member)) return
  Object.defineProperty(CSSStyleDeclarationClass.prototype, member, {
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

function camelCaseOf(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

for (const property of Object.keys(STYLE_PROPERTIES)) defineAccessor(property, kebabOf(property))
for (const name of CSS_PROPERTY_NAMES) {
  const member = camelCaseOf(name)
  defineAccessor(member, name)
  // Chrome names a vendor-prefixed property `webkitX` as well as `WebkitX`.
  if (member.startsWith("Webkit")) defineAccessor(`webkit${member.slice("Webkit".length)}`, name)
}
defineAccessor("cssFloat", "float")

export type CSSStyleDeclaration = CSSStyleDeclarationClass & { [Property in StyleProperty | "cssFloat"]: string }

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
