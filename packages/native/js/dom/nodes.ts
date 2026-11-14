/**
 * The DOM class chain every host node of both adapters sits on: `Node`, `CharacterData`,
 * `Text`, `Element`, `HTMLElement`, `SVGElement`, `Document`, `DocumentFragment` and
 * `ShadowRoot`, so `instanceof` and the tree members answer as they do in a browser.
 *
 * The classes are abstract here. What is behind a node (its parent, its children, its props)
 * is the adapter's, handed over through one method, `[DOM_BINDING]()`, which each adapter
 * class implements. The members on the prototypes read only that.
 */

import type { ElementType, NativeRenderer } from "../host.js"
import { attributeNameOf, isNotAttribute, storedAttributeNames } from "./attribute-names.js"
import { cloneNode } from "./clone.js"
import { styleDeclarationFor, type CSSStyleDeclaration, type StyleBinding } from "./css-style-declaration.js"
import { classListOf, type DOMTokenList } from "./class-list.js"
import { datasetOf } from "./dataset.js"
import type { DOMRectList } from "./dom-rect.js"
import { defineConstraintValidation } from "./constraint-validation.js"
import { defineReflectedMembers, type ReflectedMembers } from "./reflected-members.js"
import { closestElement, elementById, matchesSelector, querySelector, querySelectorAll, type ElementList } from "./selectors.js"
import * as tree from "./tree-mutation.js"

export { crossRootError } from "./tree-mutation.js"

/** Where `[DOM_BINDING]()` is read, so two copies of this package find each other's nodes. */
export const DOM_BINDING: unique symbol = Symbol.for("@ghia/native/dom-binding")

/** The element types of what every window root is made of: `html`, with `head` and `body` in it. */
export const ROOT_ELEMENT_TYPES = {
  html: "html",
  head: "head",
  body: "body",
} as const satisfies Record<string, ElementType>

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

/**
 * What an adapter does for a node that can hold children. Each goes through the adapter's own
 * paths for the same change (its mirror of the tree, the native tree, the records a
 * `MutationObserver` is handed), so a tree changed from code and one changed by the framework
 * stay one tree. The members check what the DOM checks before they call these.
 */
export type ParentBinding = NodeBinding & {
  /** Throws `crossRootError()` when `child`, or a node under it, belongs to another window: it is checked before any change. */
  assertSameWindow(child: Node): void
  /** Places `child` before `before`, or last when it is `null`, taking it out of the node it is in. */
  insertBefore(child: Node, before: Node | null): void
  /** Takes `child`, one of its children, out. The node is kept: it can be inserted again. */
  removeChild(child: Node): void
  /** A text node of the adapter that owns this node, not in any tree yet. */
  createText(data: string): Text
  /** An element of the window that owns this node, in no tree yet: `type` is one of the element types. */
  createElement(type: string): Element
}

export type ElementBinding = ParentBinding & StyleBinding & {
  /** The element type as written: `div`, `svg`, `linearGradient`. */
  readonly type: string
  /** The prop of that name. */
  prop(name: string): unknown
  /** The names of the props it was given. */
  propNames(): Iterable<string>
  /** The renderer and id the element is known by while it is mounted: where `:focus` and `:hover` are answered. */
  readonly native?: { readonly renderer: NativeRenderer; readonly id: number } | undefined
  /**
   * Gives the prop a value, through the adapter's own path for a prop it renders: native, the
   * adapter's record of the props and the `MutationObserver` records. Code's write, which the
   * framework's next render of the same prop overwrites.
   */
  setProp(name: string, value: string | number | boolean): void
}

export type TextBinding = NodeBinding & {
  readonly data: string
  /** Replaces the text, and tells native and `MutationObserver` as a framework's own update does. */
  setData(data: string): void
  /** A text node of the window that owns this one, in no tree yet. */
  createText(data: string): Text
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
  abstract set textContent(value: string | null)

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

  /**
   * A copy in no tree: an element with the attributes and the live style of this one, or a text
   * node with its data, and with `deep` the copies of its descendants. What a framework gave
   * the element beside attributes (event handlers, refs, `motion`, `layout`) is not copied.
   */
  cloneNode(deep: boolean = false): Node {
    return cloneNode(this as unknown as Node, Boolean(deep))
  }

  hasChildNodes(): boolean {
    return this[DOM_BINDING]().children.length > 0
  }

  appendChild<Child extends Node>(node: Child): Child {
    return tree.appendChild(this as unknown as Node, node)
  }

  insertBefore<Child extends Node>(node: Child, child: Node | null): Child {
    return tree.insertBefore(this as unknown as Node, node, child)
  }

  removeChild<Child extends Node>(child: Child): Child {
    return tree.removeChild(this as unknown as Node, child)
  }

  replaceChild<Child extends Node>(node: Node, child: Child): Child {
    return tree.replaceChild(this as unknown as Node, node, child)
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

  set data(value: string) {
    this[DOM_BINDING]().setData(value === null ? "" : String(value))
  }

  get nodeValue(): string {
    return this.data
  }

  set nodeValue(value: string | null) {
    this.data = value as string
  }

  get textContent(): string {
    return this.data
  }

  set textContent(value: string | null) {
    this.data = value as string
  }

  get length(): number {
    return this.data.length
  }

  remove(): void {
    tree.remove(this as unknown as Node)
  }

  before(...nodes: Array<Node | string>): void {
    tree.before(this as unknown as Node, nodes)
  }

  after(...nodes: Array<Node | string>): void {
    tree.after(this as unknown as Node, nodes)
  }

  replaceWith(...nodes: Array<Node | string>): void {
    tree.replaceWith(this as unknown as Node, nodes)
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

  /**
   * Writes the prop the attribute stands for, as if the app had rendered it. The adapters' DOM
   * members (`defineDomMembers`) define it on their prototypes.
   */
  declare setAttribute: (name: string, value: string) => void

  declare removeAttribute: (name: string) => void

  /** Dispatches an event an app built at the element. The adapters' DOM members (`defineDomMembers`) define it on their prototypes. */
  declare dispatchEvent: (event: Event) => boolean

  /**
   * Where the box is, read from native's layout. The adapters' DOM members (`defineDomMembers`) define
   * them on their prototypes; `defineBoxMembers` documents each.
   */
  declare readonly offsetParent: Element | null
  declare readonly offsetLeft: number
  declare readonly offsetTop: number
  declare readonly clientLeft: number
  declare readonly clientTop: number
  declare getClientRects: () => DOMRectList

  /** The scroll offsets, defined with the scroll members (`defineScrollMembers`). */
  declare scrollLeft: number
  declare scrollTop: number

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

  /** Sets the `id` prop, so the element is found by `#id` and `getAttribute("id")`. */
  set id(value: string) {
    this[DOM_BINDING]().setProp("id", String(value))
  }

  /**
   * The inline style, one with what the framework rendered into `style`: a write from code changes
   * the live style and a framework's next change to another property keeps it. Made on the first
   * read.
   */
  get style(): CSSStyleDeclaration {
    return styleDeclarationFor(this, this[DOM_BINDING]())
  }

  set style(cssText: string) {
    this.style.cssText = cssText
  }

  /** The `class` attribute, which is what `getAttribute` and the attributes sent to native read: `class` wins over `className`. */
  get className(): string {
    const value = this.getAttribute("class")
    return value === null ? "" : value
  }

  /** Sets the `class` attribute, as `setAttribute("class", value)` does. */
  set className(value: string) {
    this.setAttribute("class", String(value))
  }

  /** The tokens of the `class` attribute as a live `DOMTokenList`, one object per element: see `classListOf`. */
  get classList(): DOMTokenList {
    return classListOf(this as unknown as Element)
  }

  set classList(value: string) {
    this.classList.value = value
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

  /** Every child goes; a non-empty string becomes the one child, a text node. */
  set textContent(value: string | null) {
    tree.replaceAllWithText(this as unknown as Node, value)
  }

  remove(): void {
    tree.remove(this as unknown as Node)
  }

  before(...nodes: Array<Node | string>): void {
    tree.before(this as unknown as Node, nodes)
  }

  after(...nodes: Array<Node | string>): void {
    tree.after(this as unknown as Node, nodes)
  }

  replaceWith(...nodes: Array<Node | string>): void {
    tree.replaceWith(this as unknown as Node, nodes)
  }

  append(...nodes: Array<Node | string>): void {
    tree.append(this as unknown as Node, nodes)
  }

  prepend(...nodes: Array<Node | string>): void {
    tree.prepend(this as unknown as Node, nodes)
  }

  replaceChildren(...nodes: Array<Node | string>): void {
    tree.replaceChildren(this as unknown as Node, nodes)
  }

  insertAdjacentElement(where: string, element: Element): Element | null {
    return tree.insertAdjacentElement(this as unknown as Node, where, element)
  }

  insertAdjacentText(where: string, data: string): void {
    tree.insertAdjacentText(this as unknown as Node, where, data)
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null
  }

  getAttributeNames(): string[] {
    const names: string[] = []
    const svg = this instanceof shared.SVGElement
    for (const prop of this[DOM_BINDING]().propNames()) {
      if (isNotAttribute(prop)) continue
      const name = attributeNameOf(prop, svg)
      if (this.getAttribute(name) !== null && !names.includes(name)) names.push(name)
    }
    if (this.getAttribute("style") !== null && !names.includes("style")) names.push("style")
    for (const name of storedAttributeNames(this)) if (!names.includes(name)) names.push(name)
    return names
  }

  /** Adds the attribute, empty, or removes it. Gives whether it is there afterwards. */
  toggleAttribute(name: string, force?: boolean): boolean {
    if (this.hasAttribute(name)) {
      if (force === undefined || force === false) {
        this.removeAttribute(name)
        return false
      }
      return true
    }
    if (force === undefined || force === true) {
      this.setAttribute(name, "")
      return true
    }
    return false
  }

  matches(selector: string): boolean {
    return matchesSelector(this as unknown as Element, selector)
  }

  /** This element or its nearest ancestor that `selector` matches, or `null`. */
  closest(selector: string): Element | null {
    return closestElement(this as unknown as Element, selector)
  }

  /** The first descendant `selector` matches, in document order. `:scope` is this element. */
  querySelector(selector: string): Element | null {
    return querySelector(this as unknown as Element, selector, "Element")
  }

  /** The descendants `selector` matches, as a list that does not change with the tree. */
  querySelectorAll(selector: string): ElementList {
    return querySelectorAll(this as unknown as Element, selector, "Element")
  }

  /** The `data-*` attributes as a live map, with the names in camel case: see `datasetOf`. */
  get dataset(): DOMStringMap {
    return datasetOf(this as unknown as Element)
  }
}

interface ElementClass extends ReflectedMembers {}
defineReflectedMembers(ElementClass.prototype)
defineConstraintValidation(ElementClass.prototype)

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE
}

/**
 * The popover members, which the DOM has on `HTMLElement` only, defined by the adapters' DOM members (`defineDomMembers`). `popover` reads
 * the attribute limited to its known values and takes any string, `null` or `undefined`.
 */
interface HTMLElementClass {
  showPopover(): void
  hidePopover(): void
  togglePopover(force?: boolean): boolean
  get popover(): "auto" | "manual" | "hint" | null
  set popover(value: string | null | undefined)
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

  set textContent(_value: string | null) {}

  declare readonly ownerDocument: null

  querySelector(selector: string): Element | null {
    return querySelector(this as unknown as Node, selector, "Document")
  }

  querySelectorAll(selector: string): ElementList {
    return querySelectorAll(this as unknown as Node, selector, "Document")
  }

  /** The first element of any window's tree, in document order, with that `id`; `null` for none. */
  getElementById(id: string): Element | null {
    return elementById(this as unknown as Node, String(id))
  }
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

  querySelector(selector: string): Element | null {
    return querySelector(this as unknown as Node, selector, "DocumentFragment")
  }

  querySelectorAll(selector: string): ElementList {
    return querySelectorAll(this as unknown as Node, selector, "DocumentFragment")
  }

  set textContent(_value: string | null) {}
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
