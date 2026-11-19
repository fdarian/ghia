/**
 * The nodes of a document `DOMParser` made: the DOM classes of a window's nodes (`Element`, `Text`,
 * `Document`, ...) over a tree that lives only in JavaScript. Nothing here is rendered, reaches a
 * native renderer or is found by `document`: a parsed document is a place to read markup from, as in
 * a browser, where it has no browsing context either.
 *
 * Two things differ from a window's nodes. They are in no document `document` knows, so
 * `isConnected` is false and a node cannot be moved between a parsed document and a window
 * (`tree-mutation.ts` refuses it); and they hold comments, which a window's tree has no node for.
 * Everything else (attributes, `style`, the tree members, selectors, `MutationObserver`) goes
 * through the same code as a window's elements, behind the same bindings.
 */

import { bumpTreeVersion } from "../tree-version.js"
import { defineDetachedElementMembers } from "../stand-in-document.js"
import { ElementListeners } from "../../events/element-listeners.js"
import { hasMutationObservers, queueCharacterDataMutation, queueChildListMutation, recordAttributeChanges } from "../mutation-observer.js"
import { hasLiveRanges, liveRangesAfterInsert, liveRangesBeforeRemove } from "../live-ranges.js"
import { copyPrototypeMembers } from "../prototype-members.js"
import { isSvgElementType } from "../element-types.js"
import {
  CharacterData,
  DOM_BINDING,
  Document,
  DocumentFragment,
  HTMLElement,
  HTML_NAMESPACE,
  SVGElement,
  SVG_NAMESPACE,
  Text,
  type Element,
  type ElementBinding,
  type Node,
  type NodeBinding,
  type ParentBinding,
  type TextBinding,
} from "../nodes.js"
import type { StyleDesc } from "../../host.js"
import { INERT_DOCUMENT } from "./inert-marker.js"
import { StyleSheetList, styleSheetsOf } from "./style-sheet-list.js"

export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML"

const COMMENT_NODE = 8

type InertChild = Node & { parent: Node | null; readonly [INERT_DOCUMENT]: InertDocument }

/** What holds children: an element, a fragment, the document. */
type InertContainer = Node & {
  readonly kids: Node[]
  readonly [INERT_DOCUMENT]: InertDocument
  parent: Node | null
}

function wrongDocument(): DOMException {
  return new DOMException("The node belongs to another document", "WrongDocumentError")
}

function removeFrom(container: InertContainer, child: Node): void {
  const index = container.kids.indexOf(child)
  if (index < 0) throw new DOMException("The node to be removed is not a child of this node", "NotFoundError")
  if (hasLiveRanges()) liveRangesBeforeRemove(container, child, index)
  container.kids.splice(index, 1)
  ;(child as InertChild).parent = null
  bumpTreeVersion()
  if (hasMutationObservers()) queueChildListMutation(container, [], [child], container.kids[index - 1] ?? null, container.kids[index] ?? null)
}

/** Places `child` before `before`, or last, taking it out of the node it is in. */
function placeChild(container: InertContainer, child: Node, before: Node | null): void {
  const old = (child as InertChild).parent
  if (old !== null) removeFrom(old as InertContainer, child)
  const index = before === null ? container.kids.length : container.kids.indexOf(before)
  if (index < 0) throw new DOMException("The node before which the new node is to be inserted is not a child of this node", "NotFoundError")
  container.kids.splice(index, 0, child)
  ;(child as InertChild).parent = container
  bumpTreeVersion()
  if (hasLiveRanges()) liveRangesAfterInsert(container, index, 1)
  if (hasMutationObservers()) queueChildListMutation(container, [child], [], container.kids[index - 1] ?? null, container.kids[index + 1] ?? null)
}

function takeChild(container: InertContainer, child: Node): void {
  removeFrom(container, child)
}

class InertBinding implements ParentBinding {
  constructor(protected readonly node: InertContainer) {}

  get parent(): Node | null {
    return this.node.parent
  }
  get children(): readonly Node[] {
    return this.node.kids
  }
  readonly connected = false
  readonly root = null

  assertSameWindow(child: Node): void {
    if (Reflect.get(child, INERT_DOCUMENT) !== this.node[INERT_DOCUMENT]) throw wrongDocument()
  }
  insertBefore(child: Node, before: Node | null): void {
    placeChild(this.node, child, before)
  }
  removeChild(child: Node): void {
    takeChild(this.node, child)
  }
  createText(data: string): Text {
    return new InertText(this.node[INERT_DOCUMENT], data)
  }
  createElement(type: string): Element {
    return this.node[INERT_DOCUMENT].makeElement(type, isSvgElementType(type) ? SVG_NAMESPACE : HTML_NAMESPACE)
  }
  createFragment(): DocumentFragment {
    return new InertFragment(this.node[INERT_DOCUMENT])
  }
}

class InertElementBinding extends InertBinding implements ElementBinding {
  constructor(private readonly element: InertElement) {
    super(element as unknown as InertContainer)
  }

  get type(): string {
    return this.element.elementType
  }
  get style(): StyleDesc {
    return this.element.liveStyle
  }
  setStyle(next: StyleDesc): void {
    recordAttributeChanges(this.element as unknown as Element, () => ["style"], () => {
      this.element.liveStyle = next
    })
  }
  prop(name: string): unknown {
    return this.element.props.get(name)
  }
  propNames(): Iterable<string> {
    return this.element.props.keys()
  }
  setProp(name: string, value: string | number | boolean | undefined): void {
    recordAttributeChanges(
      this.element as unknown as Element,
      () => [name],
      () => {
        if (value === undefined) this.element.props.delete(name)
        else this.element.props.set(name, value)
      }
    )
  }
}

class InertCharacterBinding implements TextBinding {
  constructor(private readonly node: InertText | InertComment) {}

  get parent(): Node | null {
    return this.node.parent
  }
  readonly children: readonly Node[] = []
  readonly connected = false
  readonly root = null

  get data(): string {
    return this.node.text
  }
  setData(data: string): void {
    const before = this.node.text
    this.node.text = data
    bumpTreeVersion()
    queueCharacterDataMutation(this.node as unknown as Node, before)
  }
  createText(data: string): Text {
    return new InertText(this.node[INERT_DOCUMENT], data)
  }
  createFragment(): DocumentFragment {
    return new InertFragment(this.node[INERT_DOCUMENT])
  }
}

export class InertText extends Text {
  parent: Node | null = null
  readonly [INERT_DOCUMENT]: InertDocument
  private binding: InertCharacterBinding | undefined

  constructor(document: InertDocument, public text: string) {
    super()
    this[INERT_DOCUMENT] = document
  }

  [DOM_BINDING](): TextBinding {
    this.binding ??= new InertCharacterBinding(this)
    return this.binding
  }
}

abstract class CommentClass extends CharacterData {
  constructor() {
    super()
    if (new.target === CommentClass) throw new TypeError("Illegal constructor")
  }

  get nodeType(): number {
    return COMMENT_NODE
  }

  get nodeName(): string {
    return "#comment"
  }
}

Object.defineProperty(CommentClass, "name", { value: "Comment" })

export const Comment = CommentClass
export type Comment = CommentClass

export class InertComment extends Comment {
  parent: Node | null = null
  readonly [INERT_DOCUMENT]: InertDocument
  private binding: InertCharacterBinding | undefined

  constructor(document: InertDocument, public text: string) {
    super()
    this[INERT_DOCUMENT] = document
  }

  [DOM_BINDING](): TextBinding {
    this.binding ??= new InertCharacterBinding(this)
    return this.binding
  }
}

export class InertFragment extends DocumentFragment {
  readonly parent = null
  readonly kids: Node[] = []
  readonly [INERT_DOCUMENT]: InertDocument
  private binding: InertBinding | undefined

  constructor(document: InertDocument) {
    super()
    this[INERT_DOCUMENT] = document
  }

  [DOM_BINDING](): ParentBinding {
    this.binding ??= new InertBinding(this as unknown as InertContainer)
    return this.binding
  }
}

export class InertElement extends HTMLElement {
  parent: Node | null = null
  readonly kids: Node[] = []
  readonly props = new Map<string, unknown>()
  readonly listeners = new ElementListeners()
  liveStyle: StyleDesc = {}
  /** What a `<template>` holds, which is not among its children. */
  templateContent: InertFragment | undefined
  readonly [INERT_DOCUMENT]: InertDocument
  private binding: InertElementBinding | undefined

  constructor(
    readonly elementType: string,
    document: InertDocument,
    private readonly namespace: string
  ) {
    super()
    this[INERT_DOCUMENT] = document
  }

  [DOM_BINDING](): ElementBinding {
    this.binding ??= new InertElementBinding(this)
    return this.binding
  }

  get namespaceURI(): string {
    return this.namespace
  }

  /** The `DocumentFragment` of a `<template>`, `undefined` for any other element. */
  get content(): DocumentFragment | undefined {
    return this.templateContent
  }
}

abstract class InertSvgElement extends SVGElement {}

let membersDefined = false

/** Defined on first use, with the window's members: the classes of the DOM load before this module's dependencies finish. */
function defineMembers(): void {
  if (membersDefined) return
  membersDefined = true
  defineDetachedElementMembers(InertElement.prototype, (element: InertElement) => ({
    listeners: element.listeners,
    connected: false,
    layout: undefined,
    prop: (name) => element.props.get(name),
    propNames: () => element.props.keys(),
    setProp: (name, value) => element[DOM_BINDING]().setProp(name, value as string),
    get style() {
      return element.liveStyle
    },
  }))
  Object.defineProperty(InertElement.prototype, "ownerDocument", { configurable: true, get: documentOfNode })
  copyPrototypeMembers(InertElement.prototype, InertSvgElement.prototype)
  for (const prototype of [InertText.prototype, InertComment.prototype, InertFragment.prototype]) {
    Object.defineProperty(prototype, "ownerDocument", { configurable: true, get: documentOfNode })
  }
}

function documentOfNode(this: object): InertDocument {
  return Reflect.get(this, INERT_DOCUMENT) as InertDocument
}

class InertDocumentBinding implements NodeBinding {
  constructor(private readonly document: InertDocument) {}
  readonly parent = null
  get children(): readonly Node[] {
    return this.document.kids
  }
  readonly connected = false
  readonly root = null
}

/** What `DOMParser.parseFromString` returns, and the owner of everything in it. */
export class InertDocument extends Document {
  readonly kids: Node[] = []
  readonly parent = null
  readonly [INERT_DOCUMENT]: InertDocument = this
  /** Set by the parser when the markup has no doctype that asks for standards mode. */
  quirksMode = false
  private binding: InertDocumentBinding | undefined
  private sheets: StyleSheetList | undefined

  constructor() {
    super()
    defineMembers()
  }

  [DOM_BINDING](): NodeBinding {
    this.binding ??= new InertDocumentBinding(this)
    return this.binding
  }

  /** An element in `namespace`; the name is used as given (the parser has cased it). */
  makeElement(name: string, namespace: string): Element {
    if (namespace === SVG_NAMESPACE) return Reflect.construct(InertElement, [name, this, namespace], InertSvgElement) as unknown as Element
    return new InertElement(name, this, namespace) as unknown as Element
  }

  createElement(tagName: string): Element {
    return this.makeElement(String(tagName).toLowerCase(), HTML_NAMESPACE)
  }

  createElementNS(namespace: string | null, qualifiedName: string): Element {
    if (namespace !== HTML_NAMESPACE && namespace !== SVG_NAMESPACE && namespace !== MATHML_NAMESPACE) {
      throw new DOMException(`Elements in the namespace '${namespace}' are not supported in a parsed document`, "NotSupportedError")
    }
    return this.makeElement(String(qualifiedName), namespace)
  }

  createTextNode(data: string): Text {
    return new InertText(this, String(data))
  }

  createComment(data: string): Comment {
    return new InertComment(this, String(data))
  }

  createDocumentFragment(): DocumentFragment {
    return new InertFragment(this)
  }

  get documentElement(): Element | null {
    return this.kids.find((node) => node.nodeType === 1) as Element | undefined ?? null
  }

  get head(): Element | null {
    return this.documentElement?.children.find((child) => child.localName === "head") ?? null
  }

  get body(): Element | null {
    return this.documentElement?.children.find((child) => child.localName === "body" || child.localName === "frameset") ?? null
  }

  /** The text of the first `<title>`, with its whitespace collapsed. */
  get title(): string {
    const title = this.getElementsByTagName("title").item(0)
    return title === null ? "" : (title.textContent ?? "").replace(/[\t\n\f\r ]+/g, " ").trim()
  }

  get contentType(): string {
    return "text/html"
  }

  get characterSet(): string {
    return "UTF-8"
  }

  get compatMode(): "CSS1Compat" | "BackCompat" {
    return this.quirksMode ? "BackCompat" : "CSS1Compat"
  }

  get defaultView(): null {
    return null
  }

  get doctype(): null {
    return null
  }

  /** One `CSSStyleSheet` for each `<style>` element, in document order: read-only, applied to nothing. */
  get styleSheets(): StyleSheetList {
    this.sheets ??= styleSheetsOf(this)
    return this.sheets
  }
}
