/**
 * The selector members of the DOM classes (`matches`, `closest`, `querySelector`,
 * `querySelectorAll`), run by `css-select` over the nodes' bindings.
 *
 * A selector is compiled once and kept by its text, so a library that asks the same question on
 * every focus change (a focus trap's list of tabbable elements) pays the parse once. The tree is
 * walked in JavaScript; only `:focus`, `:focus-visible`, `:focus-within`, `:hover` and `:active`
 * ask the native renderer, because focus and pointer state live there, and `:checked` and `:indeterminate`,
 * because so does the state of a checkbox or radio.
 */

import { _compileUnsafe, type Options } from "css-select"
import { isTraversal, parse, SelectorType, type Selector } from "css-what"
import { hostElementMatches } from "../focus.js"
import { namedError } from "../named-error.js"
import { readInputChoice } from "./input-members.js"
import { DOM_BINDING, SVGElement, type Element, type Node } from "./nodes.js"

const ELEMENT_NODE = 1

/** What a query returns: a static list in document order, as `NodeList` is for `querySelectorAll`. */
export class ElementList extends Array<Element> {
  static get [Symbol.species](): ArrayConstructor {
    return Array
  }

  item(index: number): Element | null {
    return this[index] ?? null
  }
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE
}

function childrenOf(node: Node): readonly Node[] {
  return node[DOM_BINDING]().children
}

type Query = (element: Element) => boolean

/**
 * `css-select` lower-cases the attribute names of a selector, and an SVG element's names keep their
 * case (`viewBox`), so an SVG element is searched for the name without case.
 */
function attributeNameOn(element: Element, name: string): string | null {
  if (element.getAttribute(name) !== null) return name
  if (!(element instanceof SVGElement)) return null
  return element.getAttributeNames().find((own) => own.toLowerCase() === name) ?? null
}

const adapter: NonNullable<Options<Node, Element>["adapter"]> = {
  isTag: isElement,
  getAttributeValue(element, name) {
    const own = attributeNameOn(element, name)
    if (own === null) return undefined
    const value = element.getAttribute(own)
    return value === null ? undefined : value
  },
  getChildren: (node) => childrenOf(node) as Node[],
  getName: (element) => element.localName.toLowerCase(),
  getParent: (element) => element.parentNode,
  getSiblings(node) {
    const parent = node.parentNode
    return parent === null ? [node] : (childrenOf(parent) as Node[])
  },
  getText(node) {
    const text = node.textContent
    if (text === null) throw new Error(`A ${node.nodeName} has no text to read`)
    return text
  },
  hasAttrib: (element, name) => attributeNameOn(element, name) !== null,
  removeSubsets(nodes) {
    let index = nodes.length
    while (--index >= 0) {
      const node = nodes[index]
      if (index > 0 && nodes.lastIndexOf(node, index - 1) >= 0) {
        nodes.splice(index, 1)
        continue
      }
      for (let ancestor = node.parentNode; ancestor !== null; ancestor = ancestor.parentNode) {
        if (nodes.includes(ancestor)) {
          nodes.splice(index, 1)
          break
        }
      }
    }
    return nodes
  },
}

/** The element `:scope` stands for while a query runs, or `null` for a query on the document. */
const scoping: { root: Element | null } = { root: null }

function hasNoElementParent(element: Element): boolean {
  const parent = element.parentNode
  return parent === null || !isElement(parent)
}

type StatePseudo = ":focus" | ":focus-visible" | ":focus-within" | ":hover" | ":active"

/** An element that is not mounted has no focus or pointer state, so it never matches. */
function nativeState(pseudo: StatePseudo): (element: Element) => boolean {
  return (element) => {
    const native = element[DOM_BINDING]().native
    return native !== undefined && hostElementMatches(native.renderer, native.id, pseudo)
  }
}

/** What `:checked` is written in terms of, so the live state of a control decides it and not the `checked` attribute. */
const CHECKED_PSEUDO = "ghia-checked"

/** An `<input>` checkbox or radio that is checked, or a checkbox that is indeterminate, as native holds it now. */
function choiceState(wanted: (state: { checked: boolean; indeterminate: boolean; kind: string }) => boolean): (element: Element) => boolean {
  return (element) => {
    if (element.localName !== "input") return false
    const native = element[DOM_BINDING]().native
    if (native === undefined) return false
    const state = readInputChoice(native)
    return (state.kind === "checkbox" || state.kind === "radio") && wanted(state)
  }
}

/**
 * What a written `:scope` is renamed to. `css-select` puts its own `:scope` in front of every selector it
 * makes relative, which `:has(> a)` is, and that one must keep meaning the `:has()` subject.
 */
const SCOPE_PSEUDO = "ghia-scope"

/** The selector as tokens, with `:scope` renamed. A selector may not end in a combinator, or `css-select` would take it. */
function parseSelector(selector: string): Selector[][] {
  const groups = parse(selector)
  for (const rules of groups) {
    if (rules.length === 0 || isTraversal(rules[rules.length - 1])) throw new Error("it ends in a combinator or has an empty part")
    renameScope(rules)
  }
  return groups
}

function renameScope(rules: Selector[]): void {
  for (const rule of rules) {
    if (rule.type !== SelectorType.Pseudo) continue
    if (rule.name === "scope" && rule.data === null) rule.name = SCOPE_PSEUDO
    if (Array.isArray(rule.data)) for (const nested of rule.data) renameScope(nested)
  }
}

const OPTIONS: Options<Node, Element> = {
  adapter,
  // `Element.matches("> a")` is a syntax error in the DOM: only `:has()` takes a relative selector.
  relativeSelector: false,
  // A compiled selector is kept between queries and the tree changes between them.
  cacheResults: false,
  pseudos: {
    [SCOPE_PSEUDO]: (element) => (scoping.root === null ? hasNoElementParent(element) : element === scoping.root),
    // The alias replaces css-select's, which reads the `checked` attribute; `:selected` is still its own.
    checked: `:is(:${CHECKED_PSEUDO}, :selected)`,
    [CHECKED_PSEUDO]: choiceState((state) => state.checked),
    indeterminate: choiceState((state) => state.kind === "checkbox" && state.indeterminate),
    focus: nativeState(":focus"),
    "focus-visible": nativeState(":focus-visible"),
    "focus-within": nativeState(":focus-within"),
    hover: nativeState(":hover"),
    active: nativeState(":active"),
  },
}

type Compiled = { readonly query: Query } | { readonly reason: string }

const CACHE_LIMIT = 1000
const compiledSelectors = new Map<string, Compiled>()

/** A selector that fails to compile is remembered too: floating-ui asks `:popover-open` of every element, inside a `try`. */
function compileSelector(selector: string): Compiled {
  const known = compiledSelectors.get(selector)
  if (known !== undefined) return known
  const created = ((): Compiled => {
    if (selector.trim() === "") return { reason: "it is empty" }
    try {
      return { query: _compileUnsafe(parseSelector(selector), OPTIONS) }
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) }
    }
  })()
  if (compiledSelectors.size >= CACHE_LIMIT) {
    const oldest = compiledSelectors.keys().next()
    if (!oldest.done) compiledSelectors.delete(oldest.value)
  }
  compiledSelectors.set(selector, created)
  return created
}

function queryFor(selector: string, method: string, owner: string): Query {
  const compiled = compileSelector(selector)
  if ("query" in compiled) return compiled.query
  throw namedError("SyntaxError", `Failed to execute '${method}' on '${owner}': '${selector}' is not a valid selector (${compiled.reason}).`)
}

function runScoped<Result>(scope: Element | null, run: () => Result): Result {
  const previous = scoping.root
  scoping.root = scope
  try {
    return run()
  } finally {
    scoping.root = previous
  }
}

/** Walks the descendants of `root` in document order, until `visit` returns true. */
function walkDescendants(root: Node, visit: (element: Element) => boolean): void {
  const levels: Array<readonly Node[]> = [childrenOf(root)]
  const positions: number[] = [0]
  while (levels.length > 0) {
    const top = levels.length - 1
    const position = positions[top]
    if (position >= levels[top].length) {
      levels.pop()
      positions.pop()
      continue
    }
    positions[top] = position + 1
    const node = levels[top][position]
    if (!isElement(node)) continue
    if (visit(node)) return
    const children = childrenOf(node)
    if (children.length > 0) {
      levels.push(children)
      positions.push(0)
    }
  }
}

/** `root` is an element, or the document or fragment a query on it searches below. */
export function querySelectorAll(root: Node, selector: string, owner: string): ElementList {
  const query = queryFor(String(selector), "querySelectorAll", owner)
  const found = new ElementList()
  runScoped(isElement(root) ? root : null, () =>
    walkDescendants(root, (element) => {
      if (query(element)) found.push(element)
      return false
    })
  )
  return found
}

export function querySelector(root: Node, selector: string, owner: string): Element | null {
  const query = queryFor(String(selector), "querySelector", owner)
  let found: Element | null = null
  runScoped(isElement(root) ? root : null, () =>
    walkDescendants(root, (element) => {
      if (!query(element)) return false
      found = element
      return true
    })
  )
  return found
}

/** The first element below `root`, in document order, whose `id` attribute is `id`. An empty `id` is none. */
export function elementById(root: Node, id: string): Element | null {
  if (id === "") return null
  let found: Element | null = null
  walkDescendants(root, (element) => {
    if (element.getAttribute("id") !== id) return false
    found = element
    return true
  })
  return found
}

export function matchesSelector(element: Element, selector: string): boolean {
  const query = queryFor(String(selector), "matches", "Element")
  return runScoped(element, () => query(element))
}

export function closestElement(element: Element, selector: string): Element | null {
  const query = queryFor(String(selector), "closest", "Element")
  return runScoped(element, () => {
    for (let current: Node | null = element; current !== null && isElement(current); current = current.parentNode) {
      if (query(current)) return current
    }
    return null
  })
}
