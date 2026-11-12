/**
 * `element.classList`: a live `DOMTokenList` over the `class` attribute. It reads `getAttribute("class")`
 * and writes through `setAttribute("class", ...)`, the path a `class` prop and `setAttribute` take, so a
 * stylesheet, a `MutationObserver` and the framework's own `class` handling see a `classList` write
 * as they see any other attribute write.
 */

import type { Element } from "./nodes.js"

const CONSTRUCT: unique symbol = Symbol("DOMTokenList")
const SPACE = /[\t\n\f\r ]/
const SPACES = /[\t\n\f\r ]+/

function tokensOf(value: string | null): string[] {
  if (value === null) return []
  return [...new Set(value.split(SPACES).filter((token) => token !== ""))]
}

function validated(token: unknown, method: string): string {
  const text = String(token)
  if (text === "") {
    throw new DOMException(`Failed to execute '${method}' on 'DOMTokenList': The token provided must not be empty.`, "SyntaxError")
  }
  if (SPACE.test(text)) {
    throw new DOMException(
      `Failed to execute '${method}' on 'DOMTokenList': The token provided ('${text}') contains HTML space characters, which are not valid in tokens.`,
      "InvalidCharacterError"
    )
  }
  return text
}

/**
 * The element of a list, kept outside the class and under the list and its indexed view alike: a
 * private field cannot be read through the `Proxy` that gives `list[0]`, which is what `this` is
 * in a method called on the view.
 */
const elements = new WeakMap<object, Element>()

function elementOf(list: DOMTokenList): Element {
  const element = elements.get(list)
  if (element === undefined) throw new TypeError("Illegal invocation")
  return element
}

function tokensOfList(list: DOMTokenList): string[] {
  return tokensOf(elementOf(list).getAttribute("class"))
}

/** The update steps: an empty set does not create an attribute that was not there. */
function writeTokens(list: DOMTokenList, tokens: string[]): void {
  const element = elementOf(list)
  if (tokens.length === 0 && element.getAttribute("class") === null) return
  element.setAttribute("class", tokens.join(" "))
}

/** The DOM's `DOMTokenList` of one element's `class` attribute. */
export class DOMTokenList {
  constructor(element: Element, token: typeof CONSTRUCT) {
    if (token !== CONSTRUCT) throw new TypeError("Illegal constructor")
    elements.set(this, element)
  }

  get length(): number {
    return tokensOfList(this).length
  }

  get value(): string {
    return elementOf(this).getAttribute("class") ?? ""
  }

  set value(value: string) {
    elementOf(this).setAttribute("class", String(value))
  }

  item(index: number): string | null {
    return tokensOfList(this)[Number(index)] ?? null
  }

  contains(token: string): boolean {
    return tokensOfList(this).includes(String(token))
  }

  add(...tokens: string[]): void {
    const added = tokens.map((token) => validated(token, "add"))
    const current = tokensOfList(this)
    writeTokens(this, [...new Set([...current, ...added])])
  }

  remove(...tokens: string[]): void {
    const removed = new Set(tokens.map((token) => validated(token, "remove")))
    writeTokens(this, tokensOfList(this).filter((token) => !removed.has(token)))
  }

  toggle(token: string, force?: boolean): boolean {
    const wanted = validated(token, "toggle")
    const current = tokensOfList(this)
    if (current.includes(wanted)) {
      if (force === undefined || !force) {
        writeTokens(this, current.filter((entry) => entry !== wanted))
        return false
      }
      return true
    }
    if (force === undefined || force) {
      writeTokens(this, [...current, wanted])
      return true
    }
    return false
  }

  replace(token: string, newToken: string): boolean {
    const old = String(token)
    const next = String(newToken)
    if (old === "" || next === "") {
      throw new DOMException("Failed to execute 'replace' on 'DOMTokenList': The token provided must not be empty.", "SyntaxError")
    }
    validated(old, "replace")
    validated(next, "replace")
    const current = tokensOfList(this)
    if (!current.includes(old)) return false
    const result: string[] = []
    let placed = false
    for (const entry of current) {
      if (entry !== old && entry !== next) result.push(entry)
      else if (!placed) {
        result.push(next)
        placed = true
      }
    }
    writeTokens(this, result)
    return true
  }

  supports(_token: string): boolean {
    throw new TypeError("Failed to execute 'supports' on 'DOMTokenList': DOMTokenList has no supported tokens.")
  }

  forEach(callback: (token: string, index: number, list: DOMTokenList) => void, thisArg?: unknown): void {
    tokensOfList(this).forEach((token, index) => callback.call(thisArg, token, index, this))
  }

  keys(): IterableIterator<number> {
    return tokensOfList(this).keys()
  }

  values(): IterableIterator<string> {
    return tokensOfList(this).values()
  }

  entries(): IterableIterator<[number, string]> {
    return tokensOfList(this).entries()
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.values()
  }

  toString(): string {
    return this.value
  }
}

function indexOf(key: string | symbol): number | undefined {
  if (typeof key !== "string") return undefined
  // Nearly every key is a method or a property name, so the pattern runs only for one that starts with a digit.
  const first = key.charCodeAt(0)
  if (first < 48 || first > 57 || !/^(0|[1-9][0-9]*)$/.test(key)) return undefined
  return Number(key)
}

const lists = new WeakMap<object, DOMTokenList>()

/** The one `DOMTokenList` of `element`, which `list[0]` and `0 in list` read as the DOM's indexed getter does. */
export function classListOf(element: Element): DOMTokenList {
  const existing = lists.get(element)
  if (existing !== undefined) return existing
  const list = new DOMTokenList(element, CONSTRUCT)
  const view = new Proxy(list, {
    get(target, key) {
      const index = indexOf(key)
      return index === undefined ? Reflect.get(target, key, target) : target.item(index) ?? undefined
    },
    has(target, key) {
      const index = indexOf(key)
      return index === undefined ? Reflect.has(target, key) : index < target.length
    },
    ownKeys(target) {
      return [...Array.from({ length: target.length }, (_unused, index) => String(index)), ...Reflect.ownKeys(target)]
    },
    getOwnPropertyDescriptor(target, key) {
      const index = indexOf(key)
      if (index === undefined) return Reflect.getOwnPropertyDescriptor(target, key)
      const token = target.item(index)
      return token === null ? undefined : { value: token, writable: false, enumerable: true, configurable: true }
    },
  })
  elements.set(view, element)
  lists.set(element, view)
  return view
}
