/**
 * The DOM class chain every host node of both adapters sits on: `Node`, `CharacterData`,
 * `Text`, `Element`, `HTMLElement`, `SVGElement`, `Document`, `DocumentFragment` and
 * `ShadowRoot`, so `instanceof` and the tree members answer as they do in a browser.
 *
 * The classes are abstract here. What is behind a node (its parent, its children, its props)
 * is the adapter's, handed over through one method, `[DOM_BINDING]()`, which each adapter
 * class implements. The members on the prototypes read only that.
 */

import type { ElementType } from "../host.js"
import { NOT_ATTRIBUTES, attributeNameOf } from "./attribute-names.js"

/** Where `[DOM_BINDING]()` is read, so two copies of this package find each other's nodes. */
export const DOM_BINDING: unique symbol = Symbol.for("@ghia/native/dom-binding")

/** The element types of what every window root is made of: `html`, with `head` and `body` in it. */
export const ROOT_ELEMENT_TYPES = {
  html: "html",
  head: "head",
  body: "body",
} as const satisfies Record<string, ElementType>

/** Both fill the window: the box above the root is the window, and the app's top element sizes against it. */
export const ROOT_ELEMENT_STYLE = { display: "block", width: "100%", height: "100%" } as const

/** `head` has no box and its children are never drawn: it holds what the page loads, not what it shows. */
export const ROOT_HEAD_STYLE = { display: "none" } as const

/** What an adapter tells the DOM members about one of its nodes. */
export type NodeBinding = {
  /** The node it is in, or `null` at the top of a tree. */
  readonly parent: Node | null
  /** Its elements and text, in order. Read, never changed, by the members. */
  readonly children: readonly Node[]
  /** In the tree of a mounted root. */
  readonly connected: boolean
  /** The root or renderer that owns it, or `null` when it has none. */
  readonly root: object | null
}

export type ElementBinding = NodeBinding & {
  /** The element type as written: `div`, `svg`, `linearGradient`. */
  readonly type: string
  /** The prop of that name. */
  prop(name: string): unknown
  /** The names of the props it was given. */
  propNames(): Iterable<string>
}

export type TextBinding = NodeBinding & {
  readonly data: string
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const DOCUMENT_NODE = 9
const DOCUMENT_FRAGMENT_NODE = 11

const DOCUMENT_POSITION_DISCONNECTED = 1
const DOCUMENT_POSITION_PRECEDING = 2
const DOCUMENT_POSITION_FOLLOWING = 4
const DOCUMENT_POSITION_CONTAINS = 8
const DOCUMENT_POSITION_CONTAINED_BY = 16
const DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32

function illegalConstructor(): never {
  throw new TypeError("Illegal constructor")
}

/** The document the nodes belong to, set by the one `Document` the runtime creates. */
const documentState: { document: DocumentClass | null } = { document: null }

/** Order given to the trees that are not in one document, so a comparison between them is stable. */
const treeOrder = new WeakMap<object, number>()
let nextTreeOrder = 0

function orderOfTree(top: Node): number {
  const known = treeOrder.get(top)
  if (known !== undefined) return known
  const created = ++nextTreeOrder
  treeOrder.set(top, created)
  return created
}

function ancestorsOf(node: Node): Node[] {
  const chain: Node[] = []
  for (let current: Node | null = node; current !== null; current = current.parentNode) chain.push(current)
  return chain
}

abstract class NodeClass {
  static readonly ELEMENT_NODE = ELEMENT_NODE
  static readonly TEXT_NODE = TEXT_NODE
  static readonly DOCUMENT_NODE = DOCUMENT_NODE
  static readonly DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE
  static readonly DOCUMENT_POSITION_DISCONNECTED = DOCUMENT_POSITION_DISCONNECTED
  static readonly DOCUMENT_POSITION_PRECEDING = DOCUMENT_POSITION_PRECEDING
  static readonly DOCUMENT_POSITION_FOLLOWING = DOCUMENT_POSITION_FOLLOWING
  static readonly DOCUMENT_POSITION_CONTAINS = DOCUMENT_POSITION_CONTAINS
  static readonly DOCUMENT_POSITION_CONTAINED_BY = DOCUMENT_POSITION_CONTAINED_BY
  static readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC

  declare readonly ELEMENT_NODE: 1
  declare readonly TEXT_NODE: 3
  declare readonly DOCUMENT_NODE: 9
  declare readonly DOCUMENT_FRAGMENT_NODE: 11
  declare readonly DOCUMENT_POSITION_DISCONNECTED: 1
  declare readonly DOCUMENT_POSITION_PRECEDING: 2
  declare readonly DOCUMENT_POSITION_FOLLOWING: 4
  declare readonly DOCUMENT_POSITION_CONTAINS: 8
  declare readonly DOCUMENT_POSITION_CONTAINED_BY: 16
  declare readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32

  constructor() {
    if (new.target === NodeClass) illegalConstructor()
  }

  abstract [DOM_BINDING](): NodeBinding

  abstract get nodeType(): number
  abstract get nodeName(): string
  abstract get textContent(): string | null

  /**
   * Declared as a property, defined as a getter below: an adapter's element type narrows it to
   * the app's `document`, which an accessor in the class chain would not allow.
   */
  declare readonly ownerDocument: Document | null

  get isConnected(): boolean {
    return this[DOM_BINDING]().connected
  }

  get parentNode(): Node | null {
    return this[DOM_BINDING]().parent
  }

  get parentElement(): Element | null {
    const parent = this.parentNode
    return parent !== null && parent.nodeType === ELEMENT_NODE ? (parent as Element) : null
  }

  get childNodes(): readonly Node[] {
    return this[DOM_BINDING]().children.slice()
  }

  get firstChild(): Node | null {
    return this[DOM_BINDING]().children[0] ?? null
  }

  get lastChild(): Node | null {
    const children = this[DOM_BINDING]().children
    return children[children.length - 1] ?? null
  }

  get previousSibling(): Node | null {
    const siblings = this.siblings()
    if (siblings === null) return null
    const index = this.indexIn(siblings)
    return index > 0 ? siblings[index - 1] : null
  }

  get nextSibling(): Node | null {
    const siblings = this.siblings()
    if (siblings === null) return null
    return siblings[this.indexIn(siblings) + 1] ?? null
  }

  hasChildNodes(): boolean {
    return this[DOM_BINDING]().children.length > 0
  }

  /** Whether `other` is this node or one of its descendants, as the DOM has it. */
  contains(other: Node | null): boolean {
    if (other === null) return false
    for (let current: Node | null = other; current !== null; current = current.parentNode) {
      if (current === (this as unknown as Node)) return true
    }
    return false
  }

  /** The document for a mounted node, else the top of the tree it is in. */
  getRootNode(): Node {
    if (this.nodeType === DOCUMENT_NODE) return this as unknown as Node
    if (this[DOM_BINDING]().connected && documentState.document !== null) return documentState.document
    let top = this as unknown as Node
    for (let parent = top.parentNode; parent !== null; parent = top.parentNode) top = parent
    return top
  }

  compareDocumentPosition(other: Node): number {
    const self = this as unknown as Node
    if (other === self) return 0
    const selfChain = ancestorsOf(self)
    const otherChain = ancestorsOf(other)
    const selfTop = selfChain[selfChain.length - 1]
    const otherTop = otherChain[otherChain.length - 1]
    if (selfTop !== otherTop) {
      const base = DOCUMENT_POSITION_DISCONNECTED | DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC
      return base | (orderOfTree(otherTop) < orderOfTree(selfTop) ? DOCUMENT_POSITION_PRECEDING : DOCUMENT_POSITION_FOLLOWING)
    }
    if (selfChain.includes(other)) return DOCUMENT_POSITION_CONTAINS | DOCUMENT_POSITION_PRECEDING
    if (otherChain.includes(self)) return DOCUMENT_POSITION_CONTAINED_BY | DOCUMENT_POSITION_FOLLOWING
    // Walk down from the common ancestor to the two branches and compare where they leave it.
    let selfIndex = selfChain.length - 1
    let otherIndex = otherChain.length - 1
    while (selfChain[selfIndex - 1] === otherChain[otherIndex - 1]) {
      selfIndex -= 1
      otherIndex -= 1
    }
    const common = selfChain[selfIndex]
    const children = common[DOM_BINDING]().children
    return children.indexOf(otherChain[otherIndex - 1]) < children.indexOf(selfChain[selfIndex - 1])
      ? DOCUMENT_POSITION_PRECEDING
      : DOCUMENT_POSITION_FOLLOWING
  }

  private siblings(): readonly Node[] | null {
    const parent = this.parentNode
    return parent === null ? null : parent[DOM_BINDING]().children
  }

  private indexIn(siblings: readonly Node[]): number {
    const index = siblings.indexOf(this as unknown as Node)
    if (index < 0) throw new Error("The node's parent does not list it among its children")
    return index
  }
}

Object.defineProperty(NodeClass.prototype, "ownerDocument", {
  configurable: true,
  get: () => documentState.document,
})

defineConstants(NodeClass.prototype, {
  ELEMENT_NODE,
  TEXT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
  DOCUMENT_POSITION_DISCONNECTED,
  DOCUMENT_POSITION_PRECEDING,
  DOCUMENT_POSITION_FOLLOWING,
  DOCUMENT_POSITION_CONTAINS,
  DOCUMENT_POSITION_CONTAINED_BY,
  DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC,
})

function defineConstants(target: object, constants: Record<string, number>): void {
  for (const name of Object.keys(constants)) {
    Object.defineProperty(target, name, { value: constants[name], enumerable: true })
  }
}

abstract class CharacterDataClass extends NodeClass {
  constructor() {
    super()
    if (new.target === CharacterDataClass) illegalConstructor()
  }

  abstract [DOM_BINDING](): TextBinding

  get data(): string {
    return this[DOM_BINDING]().data
  }

  get nodeValue(): string {
    return this.data
  }

  get textContent(): string {
    return this.data
  }

  get length(): number {
    return this.data.length
  }
}

abstract class TextClass extends CharacterDataClass {
  constructor() {
    super()
    if (new.target === TextClass) illegalConstructor()
  }

  get nodeType(): number {
    return TEXT_NODE
  }

  get nodeName(): string {
    return "#text"
  }
}

/** The `data-*` props are the attributes `dataset` reads, with the name in camel case. */
const DATA_ATTRIBUTE = /^data-(.+)$/

function camelCase(dashed: string): string {
  return dashed.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

abstract class ElementClass extends NodeClass {
  constructor() {
    super()
    if (new.target === ElementClass) illegalConstructor()
  }

  abstract [DOM_BINDING](): ElementBinding

  /**
   * The prop of that name as a string, or `null`. The adapters' DOM members
   * (`defineDomMembers`) define it on their prototypes.
   */
  declare getAttribute: (name: string) => string | null

  abstract get tagName(): string

  get nodeType(): number {
    return ELEMENT_NODE
  }

  get nodeName(): string {
    return this.tagName
  }

  get localName(): string {
    return this[DOM_BINDING]().type
  }

  /** The `id` prop, "" when the element has none. The native handle is `nativeId`. */
  get id(): string {
    const value = this.getAttribute("id")
    return value === null ? "" : value
  }

  get className(): string {
    const binding = this[DOM_BINDING]()
    const value = binding.prop("className") ?? binding.prop("class")
    return typeof value === "string" ? value : ""
  }

  get children(): readonly Element[] {
    return this[DOM_BINDING]().children.filter(isElement)
  }

  get childElementCount(): number {
    let count = 0
    for (const child of this[DOM_BINDING]().children) if (child.nodeType === ELEMENT_NODE) count += 1
    return count
  }

  get firstElementChild(): Element | null {
    return this[DOM_BINDING]().children.find(isElement) ?? null
  }

  get lastElementChild(): Element | null {
    const children = this[DOM_BINDING]().children
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (children[index].nodeType === ELEMENT_NODE) return children[index] as Element
    }
    return null
  }

  get previousElementSibling(): Element | null {
    for (let node = this.previousSibling; node !== null; node = node.previousSibling) {
      if (node.nodeType === ELEMENT_NODE) return node as Element
    }
    return null
  }

  get nextElementSibling(): Element | null {
    for (let node = this.nextSibling; node !== null; node = node.nextSibling) {
      if (node.nodeType === ELEMENT_NODE) return node as Element
    }
    return null
  }

  get textContent(): string {
    let text = ""
    for (const child of this[DOM_BINDING]().children) text += child.textContent ?? ""
    return text
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null
  }

  getAttributeNames(): string[] {
    const names: string[] = []
    const svg = this instanceof shared.SVGElement
    for (const prop of this[DOM_BINDING]().propNames()) {
      if (NOT_ATTRIBUTES.has(prop)) continue
      const name = attributeNameOf(prop, svg)
      if (this.getAttribute(name) !== null && !names.includes(name)) names.push(name)
    }
    return names
  }

  /** A read-only view of the `data-*` attributes, with the names in camel case. */
  get dataset(): Readonly<Record<string, string>> {
    const view: Record<string, string> = {}
    for (const name of this.getAttributeNames()) {
      const match = DATA_ATTRIBUTE.exec(name)
      if (match === null) continue
      const value = this.getAttribute(name)
      if (value !== null) view[camelCase(match[1])] = value
    }
    return Object.freeze(view)
  }
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE
}

abstract class HTMLElementClass extends ElementClass {
  constructor() {
    super()
    if (new.target === HTMLElementClass) illegalConstructor()
  }

  get tagName(): string {
    return this[DOM_BINDING]().type.toUpperCase()
  }
}

abstract class SVGElementClass extends ElementClass {
  constructor() {
    super()
    if (new.target === SVGElementClass) illegalConstructor()
  }

  get tagName(): string {
    return this[DOM_BINDING]().type
  }
}

abstract class DocumentClass extends NodeClass {
  constructor() {
    super()
    if (new.target === DocumentClass) illegalConstructor()
  }

  get nodeType(): number {
    return DOCUMENT_NODE
  }

  get nodeName(): string {
    return "#document"
  }

  get textContent(): null {
    return null
  }

  declare readonly ownerDocument: null
}

Object.defineProperty(DocumentClass.prototype, "ownerDocument", { configurable: true, get: () => null })

/** Never instantiated: it exists so `node instanceof DocumentFragment` is false, not an error. */
abstract class DocumentFragmentClass extends NodeClass {
  constructor() {
    super()
    illegalConstructor()
  }

  get nodeType(): number {
    return DOCUMENT_FRAGMENT_NODE
  }

  get nodeName(): string {
    return "#document-fragment"
  }

  get textContent(): string {
    let text = ""
    for (const child of this[DOM_BINDING]().children) text += child.textContent ?? ""
    return text
  }
}

/** Never instantiated, like `DocumentFragment`, which it extends in the DOM. */
abstract class ShadowRootClass extends DocumentFragmentClass {}

type DomClassSet = {
  Node: typeof NodeClass
  CharacterData: typeof CharacterDataClass
  Text: typeof TextClass
  Element: typeof ElementClass
  HTMLElement: typeof HTMLElementClass
  SVGElement: typeof SVGElementClass
  Document: typeof DocumentClass
  DocumentFragment: typeof DocumentFragmentClass
  ShadowRoot: typeof ShadowRootClass
  /** Where the one `Document` registers itself, so every copy of this module finds it. */
  state: typeof documentState
}

const nameClasses = (classes: DomClassSet): DomClassSet => {
  for (const name of Object.keys(classes)) {
    if (name === "state") continue
    Object.defineProperty(classes[name as keyof DomClassSet], "name", { value: name })
  }
  return classes
}

const DOM_CLASSES_KEY = Symbol.for("@ghia/native/dom-classes")

/**
 * Kept on `globalThis`: a second copy of this package (a bundled app beside the workspace
 * one, `bun --hot` evaluating a module again) must share the class identity, or an element
 * built from one copy fails `instanceof` against the other.
 */
const shared: DomClassSet = (() => {
  const existing = Reflect.get(globalThis, DOM_CLASSES_KEY) as DomClassSet | undefined
  if (existing) return existing
  const created = nameClasses({
    Node: NodeClass,
    CharacterData: CharacterDataClass,
    Text: TextClass,
    Element: ElementClass,
    HTMLElement: HTMLElementClass,
    SVGElement: SVGElementClass,
    Document: DocumentClass,
    DocumentFragment: DocumentFragmentClass,
    ShadowRoot: ShadowRootClass,
    state: documentState,
  })
  Reflect.set(globalThis, DOM_CLASSES_KEY, created)
  return created
})()

export const Node = shared.Node
export type Node = NodeClass
export const CharacterData = shared.CharacterData
export type CharacterData = CharacterDataClass
export const Text = shared.Text
export type Text = TextClass
export const Element = shared.Element
export type Element = ElementClass
export const HTMLElement = shared.HTMLElement
export type HTMLElement = HTMLElementClass
export const SVGElement = shared.SVGElement
export type SVGElement = SVGElementClass
export const Document = shared.Document
export type Document = DocumentClass
export const DocumentFragment = shared.DocumentFragment
export type DocumentFragment = DocumentFragmentClass
export const ShadowRoot = shared.ShadowRoot
export type ShadowRoot = ShadowRootClass

/** @internal Makes `document` the owner of every node. Called once, by the module that creates it. */
export function registerDocument(document: Document): void {
  shared.state.document = document
}
