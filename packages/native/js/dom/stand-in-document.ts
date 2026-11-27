/**
 * The `<html>`, `<head>` and `<body>` a document answers with while no root of its window is mounted. A browser's
 * document always has them, and a library that keeps an element past the unmount reaches them
 * (floating-ui's `getOffsetParent` compares `getDocumentElement(el)` with `el.offsetParent`, and a
 * `null` there is read as a match).
 *
 * They belong to no window and no adapter: JS-only elements that answer like the elements of a
 * window that is gone (`detached-renderer.ts`). Nothing can be inserted into or removed from them,
 * since there is no window to draw the change in. When the first root mounts, what code wrote to
 * them (attributes, style, listeners) is written again to that root's elements, and they become
 * nodes in no document; the document returns fresh ones after the last root unmounts.
 */

import { createElementMethods } from "../host-runtime.js"
import { readBoundingClientRect } from "../bounds.js"
import { createDetachedRenderer } from "../detached-renderer.js"
import { defineDomMembers, type DomElement, type DomElementBinding } from "../dom-members.js"
import { ElementListeners } from "../events/element-listeners.js"
import { defineScrollMembers } from "../scroll.js"
import type { StyleDesc } from "../host.js"
import { recordAttributeChanges } from "./mutation-observer.js"
import { adoptSubtree, DOM_BINDING, HTMLElement, ROOT_ELEMENT_TYPES, type Document, type ElementBinding, type Node } from "./nodes.js"
import type { DocumentElements } from "../events/window-target.js"

type StandIns = { html: StandInElement; head: StandInElement; body: StandInElement }

/** By document: every window's document has its own, read while no root of it is mounted. */
const created = new WeakMap<Node, StandIns>()

/** The detached renderer every stand-in element measures and focuses through. */
let gone: ReturnType<typeof createDetachedRenderer> | undefined

function noWindow(element: StandInElement, what: string): never {
  throw new DOMException(
    element.replaced
      ? `This <${element.elementType}> was the document's before a root mounted and is in no document now, so ${what} of it cannot change.`
      : `The document has no root mounted, so ${what} of its <html>, <head> and <body> cannot change: render() first.`,
    "NoModificationAllowedError"
  )
}

class StandInElement extends HTMLElement {
  parent: Node | null = null
  readonly kids: StandInElement[] = []
  readonly props = new Map<string, unknown>()
  readonly listeners = new ElementListeners()
  liveStyle: StyleDesc = {}
  /** A root mounted and its elements took this one's place in the document. */
  replaced = false
  private binding: ElementBinding | undefined

  constructor(readonly elementType: string) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    this.binding ??= new StandInBinding(this)
    return this.binding
  }

}

class StandInBinding implements ElementBinding {
  constructor(private readonly element: StandInElement) {}

  get parent(): Node | null {
    return this.element.parent
  }
  get children(): readonly Node[] {
    return this.element.kids
  }
  get connected(): boolean {
    return !this.element.replaced
  }
  readonly root = null
  get type(): string {
    return this.element.elementType
  }
  get style(): StyleDesc {
    return this.element.liveStyle
  }
  setStyle(next: StyleDesc): void {
    this.element.liveStyle = next
  }
  prop(name: string): unknown {
    return this.element.props.get(name)
  }
  propNames(): Iterable<string> {
    return this.element.props.keys()
  }
  setProp(name: string, value: string | number | boolean | undefined): void {
    recordAttributeChanges(
      this.element,
      () => [name],
      () => {
        if (value === undefined) this.element.props.delete(name)
        else this.element.props.set(name, value)
      }
    )
  }
  assertSameWindow(): void {
    noWindow(this.element, "the children")
  }
  insertBefore(): void {
    noWindow(this.element, "the children")
  }
  removeChild(): void {
    noWindow(this.element, "the children")
  }
  createText(): never {
    return noWindow(this.element, "the text")
  }
  createElement(): never {
    return noWindow(this.element, "the elements")
  }
  createFragment(): never {
    return noWindow(this.element, "the fragments")
  }
}

function detachedRenderer(): ReturnType<typeof createDetachedRenderer> {
  gone ??= createDetachedRenderer()
  return gone
}

/**
 * The members of an element that has no window: the DOM members, the scroll members and the pointer-capture and animation
 * methods, which answer through the detached renderer. Shared with the elements of a parsed document (`html/inert-nodes.ts`).
 */
export function defineDetachedElementMembers<This extends object>(target: object, bind: (self: This) => DomElementBinding): void {
  defineDomMembers(target, bind)
  defineScrollMembers(target, () => ({ renderer: detachedRenderer(), id: 0 }))
  const methods = createElementMethods(detachedRenderer(), 0)
  Object.defineProperties(target, {
    focus: { value: () => {}, writable: true, configurable: true },
    blur: { value: () => {}, writable: true, configurable: true },
    getBoundingClientRect: { value: () => readBoundingClientRect(detachedRenderer(), 0), writable: true, configurable: true },
  })
  for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture", "click", "requestPointerLock", "getAnimations", "animate"] as const) {
    Object.defineProperty(target, name, { value: methods[name], writable: true, configurable: true })
  }
}

let membersDefined = false

/** Members are defined on first use: this module is loaded by the document's own, which `dom-members` loads too. */
function create(document: Node): StandIns {
  if (!membersDefined) {
    membersDefined = true
    defineDetachedElementMembers(StandInElement.prototype, (element: StandInElement) => ({
      listeners: element.listeners,
      get connected() {
        return !element.replaced
      },
      layout: undefined,
      prop: (name) => element.props.get(name),
      propNames: () => element.props.keys(),
      setProp: (name, value) => element[DOM_BINDING]().setProp(name, value as string),
      get style() {
        return element.liveStyle
      },
    }))
  }
  const html = new StandInElement(ROOT_ELEMENT_TYPES.html)
  const head = new StandInElement(ROOT_ELEMENT_TYPES.head)
  const body = new StandInElement(ROOT_ELEMENT_TYPES.body)
  html.parent = document
  for (const child of [head, body]) {
    child.parent = html
    html.kids.push(child)
  }
  for (const element of [html, head, body]) adoptSubtree(element, document as Document)
  return { html, head, body }
}

/** The stand-in `<html>` with its `<head>` and `<body>` of `document`, made when first read; `document` is where `html`'s `parentNode` points. */
export function standInDocumentElements(document: Node): DocumentElements {
  const known = created.get(document)
  if (known !== undefined) return known
  const made = create(document)
  created.set(document, made)
  return made
}

/**
 * The first root mounted. What was written to the stand-ins goes through the ordinary paths of the
 * elements of that root (so a stylesheet and a `MutationObserver` see it), and the stand-ins are
 * then nodes in no document. A stand-in nobody read has nothing to give.
 */
export function replaceStandInDocumentElements(document: Node, mounted: DocumentElements): void {
  const standIns = created.get(document)
  if (standIns === undefined) return
  created.delete(document)
  for (const part of ["html", "head", "body"] as const) {
    const from = standIns[part]
    const to = mounted[part] as DomElement
    for (const name of from.getAttributeNames()) {
      const text = from.getAttribute(name)
      if (text === null) throw new Error(`The stand-in <${from.elementType}> lists the attribute "${name}" and has no text for it`)
      to.setAttribute(name, text)
    }
    for (const added of from.listeners.addedListeners()) to.addEventListener(added.type, added.listener, added.options)
    from.replaced = true
  }
  standIns.html.parent = null
}
