/**
 * `element.style`: the `CSSStyleDeclaration` of an element's inline style.
 *
 * What it reads and writes is the style the adapter keeps for the element, the one native is
 * sent: the framework's `style` prop with the writes of the declaration laid over it. A write
 * hands the adapter the whole next style object (`StyleBinding.writeStyle`), which queues it for
 * native once per flush, however many writes came before it. A framework commit that changes or
 * removes a property replaces the written one (`keepWrittenEntries`); the properties it leaves
 * alone keep what was written, as React DOM sets only the keys that changed.
 *
 * Properties are stored under the keys of a style object (`backgroundColor`, `--x`), so a
 * property Ghia has no style key for is stored and read back and reaches nothing.
 */

import { hasMutationObservers, queueAttributeMutation } from "./mutation-observer.js"
import { CSS_PROPERTY_NAMES } from "./css-property-names.js"
import type { Element } from "./nodes.js"

type StyleObject = Record<string, unknown>

/** What an adapter tells the declaration of one of its elements. */
export type StyleBinding = {
  /** The style the element holds now, or `undefined` when it has none. Read, never changed. */
  readStyle(): Readonly<StyleObject> | undefined
  /** Makes `next` the element's style and queues it for native. */
  writeStyle(next: StyleObject): void
}

/**
 * The style an element has after a framework commit when `written` is what it holds because the
 * declaration wrote to it since `before`, the style the framework last committed. As in the DOM, a
 * property the commit changes or removes takes the framework's value; one it left as it was keeps
 * the written one, and a property the framework never set stays. Gives `after` itself when
 * nothing is kept.
 */
export function keepWrittenEntries<Entries extends object>(
  written: Entries | undefined,
  before: Entries | undefined,
  after: Entries | undefined
): Entries | undefined {
  if (written === before) return after
  const wrote = (written ?? NO_ENTRIES) as Record<string, unknown>
  const had = (before ?? NO_ENTRIES) as Record<string, unknown>
  const has = (after ?? NO_ENTRIES) as Record<string, unknown>
  let merged: Record<string, unknown> | undefined
  const consider = (key: string) => {
    const wroteIt = wrote[key] !== undefined
    const hadIt = had[key] !== undefined
    if (wroteIt === hadIt && Object.is(wrote[key], had[key])) return
    const committed = hadIt ? has[key] === undefined || !Object.is(had[key], has[key]) : has[key] !== undefined
    if (committed) return
    merged ??= { ...has }
    if (wroteIt) merged[key] = wrote[key]
    else delete merged[key]
  }
  for (const key of Object.keys(wrote)) consider(key)
  for (const key of Object.keys(had)) if (!(key in wrote)) consider(key)
  return (merged as Entries | undefined) ?? after
}

const NO_ENTRIES = {}

const UNITLESS = new Set([
  "animationIterationCount", "aspectRatio", "borderImageOutset", "borderImageSlice", "borderImageWidth",
  "columnCount", "columns", "flex", "flexGrow", "flexShrink", "fontWeight", "gridArea", "gridColumn",
  "gridColumnEnd", "gridColumnStart", "gridRow", "gridRowEnd", "gridRowStart", "lineClamp", "lineHeight",
  "opacity", "order", "orphans", "scale", "tabSize", "widows", "zIndex", "zoom",
  "fillOpacity", "floodOpacity", "stopOpacity", "strokeDasharray", "strokeDashoffset", "strokeMiterlimit",
  "strokeOpacity", "strokeWidth",
])

/** The text a style value is read as: a string as it is, a number as React DOM writes it, anything else (a state style, a motion value) as no value. */
function textOf(key: string, value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  if (value === 0) return "0"
  return key.startsWith("--") || UNITLESS.has(key) ? String(value) : `${value}px`
}

/** `background-color` and `backgroundColor` are the key `backgroundColor`; a custom property keeps its name. */
function styleKeyOf(name: string): string {
  if (name.startsWith("--")) return name
  return name.toLowerCase().replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function propertyNameOf(key: string): string {
  if (key.startsWith("--")) return key
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

type Declaration = { name: string; value: string; important: boolean }

const IMPORTANT = /\s*!\s*important\s*$/i
const PROPERTY_NAME = /^(?:--.+|-?[a-z_][a-z0-9_-]*)$/i

/** Splits CSS text at the top-level `;`, skipping comments, strings and brackets. */
function splitDeclarations(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ""
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (quote !== "") {
      if (char === "\\") index++
      else if (char === quote) quote = ""
    } else if (char === "/" && text.charAt(index + 1) === "*") {
      const end = text.indexOf("*/", index + 2)
      index = end < 0 ? text.length : end + 1
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === "(" || char === "[" || char === "{") {
      depth++
    } else if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1)
    } else if (char === ";" && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function withoutComments(text: string): string {
  let result = ""
  let quote = ""
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    if (quote !== "") {
      result += char
      if (char === "\\" && index + 1 < text.length) result += text.charAt(++index)
      else if (char === quote) quote = ""
    } else if (char === "/" && text.charAt(index + 1) === "*") {
      const end = text.indexOf("*/", index + 2)
      index = end < 0 ? text.length : end + 1
    } else {
      if (char === '"' || char === "'") quote = char
      result += char
    }
  }
  return result
}

/** The declarations of a `style` attribute, in order. One that does not parse is dropped, as in CSS. */
function parseDeclarations(text: string): Declaration[] {
  const declarations: Declaration[] = []
  for (const part of splitDeclarations(withoutComments(text))) {
    const colon = part.indexOf(":")
    if (colon < 0) continue
    const rawName = part.slice(0, colon).trim()
    if (!PROPERTY_NAME.test(rawName)) continue
    let value = part.slice(colon + 1).trim()
    const important = IMPORTANT.test(value)
    if (important) value = value.replace(IMPORTANT, "")
    if (value === "") continue
    declarations.push({ name: rawName.startsWith("--") ? rawName : rawName.toLowerCase(), value, important })
  }
  return declarations
}

type DeclarationState = {
  readonly owner: Element
  readonly binding: () => StyleBinding
  /** Whether the style attribute exists: a write made it, `removeAttribute("style")` takes it away. */
  attribute: boolean
  /** The text of each property written with `important`; it counts only while the property still holds that text. */
  readonly important: Map<string, string>
}

const STATE = Symbol("@ghia/native/style-declaration-state")
const CREATE = Symbol("@ghia/native/style-declaration-create")

function stateOf(declaration: CSSStyleDeclarationClass): DeclarationState {
  return declaration[STATE]
}

function currentStyle(state: DeclarationState): Readonly<StyleObject> {
  return state.binding().readStyle() ?? NO_ENTRIES
}

function priorityOf(state: DeclarationState, key: string, text: string): string {
  return state.important.get(key) === text ? "important" : ""
}

function cssTextOf(state: DeclarationState): string {
  const style = currentStyle(state)
  const declarations: string[] = []
  for (const key of Object.keys(style)) {
    const text = textOf(key, style[key])
    if (text === "") continue
    const priority = priorityOf(state, key, text)
    declarations.push(`${propertyNameOf(key)}: ${text}${priority === "" ? "" : " !important"};`)
  }
  return declarations.join(" ")
}

/** Runs `edit` on a copy of the style, hands the copy over, and queues one record for the `style` attribute if its text changed. */
function changeStyle(state: DeclarationState, edit: (next: StyleObject) => void): void {
  const observed = hasMutationObservers()
  const before = observed ? cssTextOf(state) : ""
  const next: StyleObject = { ...currentStyle(state) }
  edit(next)
  state.attribute = true
  state.binding().writeStyle(next)
  if (!observed) return
  if (cssTextOf(state) !== before) queueAttributeMutation(state.owner, "style", before)
}

function readProperty(state: DeclarationState, name: string): string {
  const key = styleKeyOf(name)
  return textOf(key, currentStyle(state)[key])
}

function writeProperty(state: DeclarationState, name: string, value: string, priority: string): void {
  const key = styleKeyOf(name)
  const text = value.trim()
  if (text === "") {
    removeProperty(state, name)
    return
  }
  const important = priority.toLowerCase() === "important"
  if (priority !== "" && !important) return
  if (textOf(key, currentStyle(state)[key]) === text && (priorityOf(state, key, text) === "important") === important) return
  changeStyle(state, (next) => {
    next[key] = text
    if (important) state.important.set(key, text)
    else state.important.delete(key)
  })
}

function removeProperty(state: DeclarationState, name: string): string {
  const key = styleKeyOf(name)
  const style = currentStyle(state)
  if (style[key] === undefined) return ""
  const old = textOf(key, style[key])
  changeStyle(state, (next) => {
    delete next[key]
    state.important.delete(key)
  })
  return old
}

function isProperty(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number"
}

function writeCssText(state: DeclarationState, text: string): void {
  const declarations = parseDeclarations(text)
  changeStyle(state, (next) => {
    // A state style (`hover`) or a motion value is no CSS property: `cssText` has nothing to say about it.
    for (const key of Object.keys(next)) if (isProperty(next[key])) delete next[key]
    state.important.clear()
    for (const declaration of declarations) {
      const key = styleKeyOf(declaration.name)
      delete next[key]
      next[key] = declaration.value
      if (declaration.important) state.important.set(key, declaration.value)
      else state.important.delete(key)
    }
  })
}

function propertyKeys(state: DeclarationState): string[] {
  const style = currentStyle(state)
  return Object.keys(style).filter((key) => textOf(key, style[key]) !== "")
}

class CSSStyleDeclarationClass {
  readonly [STATE]: DeclarationState

  constructor(create: symbol, state: DeclarationState) {
    if (create !== CREATE) throw new TypeError("Illegal constructor")
    this[STATE] = state
  }

  get cssText(): string {
    return cssTextOf(stateOf(this))
  }

  set cssText(text: string) {
    writeCssText(stateOf(this), String(text))
  }

  /** The number of properties set, shorthands as the framework gave them, not expanded to longhands. */
  get length(): number {
    return propertyKeys(stateOf(this)).length
  }

  get parentRule(): null {
    return null
  }

  item(index: number): string {
    const key = propertyKeys(stateOf(this))[index]
    return key === undefined ? "" : propertyNameOf(key)
  }

  getPropertyValue(name: string): string {
    return readProperty(stateOf(this), String(name))
  }

  getPropertyPriority(name: string): string {
    const state = stateOf(this)
    const key = styleKeyOf(String(name))
    return priorityOf(state, key, textOf(key, currentStyle(state)[key]))
  }

  /**
   * An empty value removes the property. `important` is stored and read back and has no effect:
   * the inline style already wins over every other rule.
   */
  setProperty(name: string, value: string | null, priority: string = ""): void {
    writeProperty(stateOf(this), String(name), value === null ? "" : String(value), String(priority))
  }

  /** Gives the value the property had, or `""`. */
  removeProperty(name: string): string {
    return removeProperty(stateOf(this), String(name))
  }

  *[Symbol.iterator](): IterableIterator<string> {
    for (const key of propertyKeys(stateOf(this))) yield propertyNameOf(key)
  }
}

Object.defineProperty(CSSStyleDeclarationClass, "name", { value: "CSSStyleDeclaration" })

function defineAccessor(accessor: string, key: string): void {
  Object.defineProperty(CSSStyleDeclarationClass.prototype, accessor, {
    configurable: true,
    enumerable: true,
    get(this: CSSStyleDeclarationClass) {
      const state = stateOf(this)
      return textOf(key, currentStyle(state)[key])
    },
    set(this: CSSStyleDeclarationClass, value: unknown) {
      writeProperty(stateOf(this), propertyNameOf(key), value === null || value === undefined ? "" : String(value), "")
    },
  })
}

for (const name of CSS_PROPERTY_NAMES) {
  const key = styleKeyOf(name)
  defineAccessor(key, key)
  // Chrome names the vendor-prefixed ones `webkitX` as well as `WebkitX`.
  if (key.startsWith("Webkit")) defineAccessor(`webkit${key.slice("Webkit".length)}`, key)
}
defineAccessor("cssFloat", "float")

export type CSSStyleDeclaration = CSSStyleDeclarationClass
export const CSSStyleDeclaration: typeof CSSStyleDeclarationClass = CSSStyleDeclarationClass

const declarations = new WeakMap<Element, CSSStyleDeclarationClass>()

/** The one declaration of `owner`; `binding` finds what is behind it. */
export function styleDeclarationOf(owner: Element, binding: () => StyleBinding): CSSStyleDeclaration {
  const existing = declarations.get(owner)
  if (existing !== undefined) return existing
  const created = new CSSStyleDeclarationClass(CREATE, { owner, binding, attribute: false, important: new Map() })
  declarations.set(owner, created)
  return created
}

/** What `getAttribute("style")` gives: the text, or `null` for an element nothing has written a style to. */
export function styleAttributeOf(declaration: CSSStyleDeclaration): string | null {
  const state = stateOf(declaration)
  const text = cssTextOf(state)
  return text === "" && !state.attribute ? null : text
}

/** `setAttribute("style", text)`, and `removeAttribute("style")` for `null`. */
export function writeStyleAttribute(declaration: CSSStyleDeclaration, text: string | null): void {
  const state = stateOf(declaration)
  writeCssText(state, text ?? "")
  if (text === null) state.attribute = false
}
