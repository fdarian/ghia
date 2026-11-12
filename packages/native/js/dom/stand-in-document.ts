/**
 * The `<html>`, `<head>` and `<body>` `document` answers with while no root is mounted. A browser's
 * document always has them, and a library that keeps an element past the unmount reaches them
 * (floating-ui's `getOffsetParent` compares `getDocumentElement(el)` with `el.offsetParent`, and a
 * `null` there is read as a match).
 *
 * They belong to no window and no adapter: JS-only elements that answer like the elements of a
 * window that is gone (`detached-renderer.ts`), and the document stops listing them as soon as a
 * root mounts and brings its own. Nothing can be inserted into or removed from them, since there
 * is no window to draw the change in.
 */

import { createElementMethods } from "../host-runtime.js"
import { readBoundingClientRect } from "../bounds.js"
import { createDetachedRenderer } from "../detached-renderer.js"
import { defineDomMembers } from "../dom-members.js"
import { ElementListeners } from "../events/element-listeners.js"
import { defineScrollMembers } from "../scroll.js"
import type { StyleDesc } from "../host.js"
import { DOM_BINDING, HTMLElement, ROOT_ELEMENT_TYPES, type ElementBinding, type Node } from "./nodes.js"
import type { DocumentElements } from "../events/window-target.js"

let created: DocumentElements | undefined

/** The detached renderer every stand-in element measures and focuses through. */
let gone: ReturnType<typeof createDetachedRenderer> | undefined

function noWindow(what: string): never {
  throw new DOMException(
    `The document has no root mounted, so ${what} of its <html>, <head> and <body> cannot change: render() first.`,
    "NoModificationAllowedError"
  )
}

class StandInElement extends HTMLElement {
  parent: Node | null = null
  readonly kids: StandInElement[] = []
  readonly props = new Map<string, unknown>()
  readonly listeners = new ElementListeners()
  liveStyle: StyleDesc = {}
  private binding: ElementBinding | undefined

  constructor(readonly type: string) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    this.binding ??= new StandInBinding(this)
    return this.binding
  }

  focus(): void {}
  blur(): void {}

  getBoundingClientRect() {
    return readBoundingClientRect(detachedRenderer(), 0)
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
  readonly connected = true
  readonly root = null
  get type(): string {
    return this.element.type
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
    if (value === undefined) this.element.props.delete(name)
    else this.element.props.set(name, value)
  }
  assertSameWindow(): void {
    noWindow("the children")
  }
  insertBefore(): void {
    noWindow("the children")
  }
  removeChild(): void {
    noWindow("the children")
  }
  createText(): never {
    return noWindow("the text")
  }
  createElement(): never {
    return noWindow("the elements")
  }
}

function detachedRenderer(): ReturnType<typeof createDetachedRenderer> {
  gone ??= createDetachedRenderer()
  return gone
}

/** Members are defined on first use: this module is loaded by the document's own, which `dom-members` loads too. */
function create(document: Node): DocumentElements {
  defineDomMembers(StandInElement.prototype, (element: StandInElement) => ({
    listeners: element.listeners,
    connected: true,
    layout: undefined,
    prop: (name) => element.props.get(name),
    propNames: () => element.props.keys(),
    setProp: (name, value) => element[DOM_BINDING]().setProp(name, value as string),
    get style() {
      return element.liveStyle
    },
  }))
  defineScrollMembers(StandInElement.prototype, () => ({ renderer: detachedRenderer(), id: 0 }))
  const methods = createElementMethods(detachedRenderer(), 0)
  for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture", "click", "requestPointerLock", "getAnimations", "animate"] as const) {
    Object.defineProperty(StandInElement.prototype, name, { value: methods[name], writable: true, configurable: true })
  }
  const html = new StandInElement(ROOT_ELEMENT_TYPES.html)
  const head = new StandInElement(ROOT_ELEMENT_TYPES.head)
  const body = new StandInElement(ROOT_ELEMENT_TYPES.body)
  html.parent = document
  for (const child of [head, body]) {
    child.parent = html
    html.kids.push(child)
  }
  return { html, head, body }
}

/** The one stand-in `<html>` with its `<head>` and `<body>`, made when first read; `document` is where `html`'s `parentNode` points. */
export function standInDocumentElements(document: Node): DocumentElements {
  created ??= create(document)
  return created
}
