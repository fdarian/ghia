/**
 * `getElementsByTagName`, `getElementsByClassName` and `getElementsByName`, and the live lists they
 * return. A list is a search, and it keeps what the search found until the tree or an attribute
 * changes (`tree-version.ts`), so a loop over `length` and indices walks the tree once and a list
 * still follows the tree as a browser's does.
 */

import { indexedView, splitOnSpaces } from "./indexed-view.js"
import { findDescendants } from "./selectors.js"
import { SVGElement, type Element, type Node } from "./nodes.js"
import { treeVersion } from "./tree-version.js"

type Search = () => readonly Element[]

/** Where a list keeps its search, on the list itself, so a method called on the proxy finds it. */
const SEARCH = Symbol("search")
const CREATE = Symbol("create live list")

function searchOf(list: object): Search {
  return Reflect.get(list, SEARCH) as Search
}

/** An HTML element's `id`, or its `name` attribute: what `namedItem` looks for. */
function namedElement(elements: readonly Element[], name: string): Element | null {
  if (name === "") return null
  for (const element of elements) {
    if (element.getAttribute("id") === name) return element
    if (!(element instanceof SVGElement) && element.getAttribute("name") === name) return element
  }
  return null
}

abstract class LiveList {
  constructor(token?: symbol) {
    if (token !== CREATE) throw new TypeError("Illegal constructor")
  }

  get length(): number {
    return searchOf(this)().length
  }

  item(index: number): Element | null {
    return searchOf(this)()[Number(index)] ?? null
  }

  [Symbol.iterator](): IterableIterator<Element> {
    return searchOf(this)()[Symbol.iterator]()
  }
}

/** A live list of elements in document order: what `getElementsByTagName` and `getElementsByClassName` return. */
abstract class HTMLCollectionClass extends LiveList {
  [index: number]: Element

  namedItem(name: string): Element | null {
    return namedElement(searchOf(this)(), String(name))
  }
}

/** A live list of nodes: what `getElementsByName` returns. It has no `namedItem`, as in the DOM. */
abstract class NodeListClass extends LiveList {
  [index: number]: Element

  forEach(callback: (element: Element, index: number, list: NodeListClass) => void, thisArg?: unknown): void {
    searchOf(this)().forEach((element, index) => callback.call(thisArg, element, index, this))
  }

  entries(): IterableIterator<[number, Element]> {
    return searchOf(this)().entries()
  }

  keys(): IterableIterator<number> {
    return searchOf(this)().keys()
  }

  values(): IterableIterator<Element> {
    return searchOf(this)().values()
  }
}

Object.defineProperty(HTMLCollectionClass.prototype, Symbol.toStringTag, { value: "HTMLCollection", configurable: true })
Object.defineProperty(NodeListClass.prototype, Symbol.toStringTag, { value: "NodeList", configurable: true })

type ClassSet = { HTMLCollection: typeof HTMLCollectionClass; NodeList: typeof NodeListClass }

const CLASSES_KEY = Symbol.for("@ghia/native/live-list-classes")

/**
 * Kept on `globalThis` like the DOM classes: a second copy of this package must share the class
 * identity, or `collection instanceof HTMLCollection` fails across copies.
 */
const shared: ClassSet = (() => {
  const existing = Reflect.get(globalThis, CLASSES_KEY) as ClassSet | undefined
  if (existing) return existing
  for (const [name, list] of [["HTMLCollection", HTMLCollectionClass], ["NodeList", NodeListClass]] as const) {
    Object.defineProperty(list, "name", { value: name })
  }
  const created: ClassSet = { HTMLCollection: HTMLCollectionClass, NodeList: NodeListClass }
  Reflect.set(globalThis, CLASSES_KEY, created)
  return created
})()

export const HTMLCollection = shared.HTMLCollection
export type HTMLCollection = HTMLCollectionClass
export const NodeList = shared.NodeList
export type NodeList = NodeListClass

/** Runs `search` again only when the tree version moved since the last run. */
function remembered(search: Search): Search {
  let version = -1
  let found: readonly Element[] = []
  return () => {
    const current = treeVersion()
    if (current !== version) {
      found = search()
      version = current
    }
    return found
  }
}

function listOver<List extends LiveList>(prototype: object, elements: Search, named: boolean): List {
  const list = Object.create(prototype) as List
  Object.defineProperty(list, SEARCH, { value: elements })
  return indexedView(
    list,
    { length: () => elements().length, at: (index) => elements()[index] },
    named ? { get: (name) => namedElement(elements(), name) ?? undefined, has: (name) => namedElement(elements(), name) !== null } : undefined
  )
}

function live<List extends LiveList>(prototype: object, search: Search, named: boolean): List {
  return listOver(prototype, remembered(search), named)
}

function matchingTag(name: string): (element: Element) => boolean {
  if (name === "*") return () => true
  const lowered = name.toLowerCase()
  // An HTML element answers to either case; an SVG element's name keeps its case (`foreignObject`).
  return (element) => element.localName === (element instanceof SVGElement ? name : lowered)
}

function classTokens(element: Element): string[] {
  return splitOnSpaces(element.getAttribute("class") ?? "")
}

/** The elements below `root` (not `root`) with that tag name; `"*"` is all of them. */
export function elementsByTagName(root: Node, name: string): HTMLCollection {
  const test = matchingTag(String(name))
  return live<HTMLCollection>(HTMLCollectionClass.prototype, () => findDescendants(root, test), true)
}

/** The elements below `root` that carry every class of the whitespace-separated `names`; none when it names none. */
export function elementsByClassName(root: Node, names: string): HTMLCollection {
  const wanted = splitOnSpaces(String(names))
  return live<HTMLCollection>(
    HTMLCollectionClass.prototype,
    () => {
      if (wanted.length === 0) return []
      return findDescendants(root, (element) => {
        const have = classTokens(element)
        return wanted.every((token) => have.includes(token))
      })
    },
    true
  )
}

/** The HTML elements below `root` whose `name` attribute is `name`. */
export function elementsByName(root: Node, name: string): NodeList {
  const wanted = String(name)
  return live<NodeList>(
    NodeListClass.prototype,
    () => findDescendants(root, (element) => !(element instanceof SVGElement) && element.getAttribute("name") === wanted),
    false
  )
}
