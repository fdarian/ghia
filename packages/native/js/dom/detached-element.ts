/**
 * The element `document.createElement` makes: an HTML element that belongs to no tree. A library
 * makes one to measure something, to test a feature (`createElement('div').focus(options)` to see
 * whether `preventScroll` is read), or as the stand-in for an element it has not been given.
 *
 * It is not a host element of a framework: nothing mounts it, it has no parent or children and
 * `appendChild` and the other members that change a tree are not there, so inserting it is up to
 * a framework (a ref or a portal). Native knows nothing of it. Its attributes, `style` and
 * listeners work as an element's do, and every member that reads a box reads the box of an element
 * that is not in a document: 0, or empty.
 */

import { defineDomMembers, type DomElementBinding } from "../dom-members.js"
import { HOST_BINDING, toBoundingClientRect, type BoundingClientRect, type HostBinding } from "../bounds.js"
import { ElementListeners } from "../events/element-listeners.js"
import { namedError } from "../named-error.js"
import { DOM_BINDING, HTMLElement, registerElementFactory, type Element, type ElementBinding, type Node } from "./nodes.js"

/** The `Name` production of XML, as `createElement` checks it, with every non-ASCII character allowed. */
const NAME = /^[A-Za-z_:\u0080-￿][A-Za-z0-9_:.\u0080-￿-]*$/

class DetachedState implements DomElementBinding {
  readonly listeners = new ElementListeners()
  readonly props = new Map<string, unknown>()
  style: Record<string, unknown> | undefined
  readonly parent = null
  readonly children: readonly Node[] = []
  readonly connected = false
  readonly root = null
  readonly layout = undefined
  readonly native = undefined

  constructor(readonly type: string) {}

  prop(name: string): unknown {
    return this.props.get(name)
  }

  propNames(): Iterable<string> {
    return this.props.keys()
  }

  writeProp(name: string, value: string | number | boolean | undefined): void {
    if (value === undefined) this.props.delete(name)
    else this.props.set(name, value)
  }

  readStyle(): Readonly<Record<string, unknown>> | undefined {
    return this.style
  }

  writeStyle(next: Record<string, unknown>): void {
    this.style = next
  }
}

const states = new WeakMap<object, DetachedState>()

function stateOf(element: object): DetachedState {
  const state = states.get(element)
  if (state === undefined) throw new Error("Not a detached element")
  return state
}

class DetachedElement extends HTMLElement {
  constructor(type: string) {
    super()
    states.set(this, new DetachedState(type))
  }

  [DOM_BINDING](): ElementBinding {
    return stateOf(this)
  }

  /** An element that is not mounted has no native id; `getComputedStyle` reads it only for a mounted one. */
  get nativeId(): number {
    throw new Error("A detached element has no native id")
  }

  [HOST_BINDING](): HostBinding | undefined {
    return undefined
  }

  /** Reads `preventScroll` as the DOM's dictionary conversion does, and takes no focus: an element that is not in a document cannot hold it. */
  focus(options?: FocusOptions): void {
    void options?.preventScroll
  }

  blur(): void {}

  getBoundingClientRect(): BoundingClientRect {
    return toBoundingClientRect(null)
  }
}

defineDomMembers(DetachedElement.prototype, (element: DetachedElement) => stateOf(element))

/** The scroll members of an element that does not scroll: no offsets, and a write or a scroll changes nothing. */
for (const name of ["scrollTop", "scrollLeft", "scrollWidth", "scrollHeight", "clientWidth", "clientHeight"]) {
  Object.defineProperty(DetachedElement.prototype, name, {
    configurable: true,
    get: () => 0,
    set: () => {},
  })
}
for (const name of ["scrollTo", "scrollBy", "scrollIntoView"]) {
  Object.defineProperty(DetachedElement.prototype, name, { configurable: true, writable: true, value: () => {} })
}

function createDetachedElement(localName: string): Element {
  const name = String(localName)
  if (!NAME.test(name)) {
    throw namedError("InvalidCharacterError", `Failed to execute 'createElement' on 'Document': The tag name provided ('${name}') is not a valid name.`)
  }
  return new DetachedElement(name.toLowerCase()) as unknown as Element
}

registerElementFactory(createDetachedElement)
