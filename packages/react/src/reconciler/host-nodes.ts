/// The DOM nodes a React root hands out: host elements and text. They are classes on the DOM
/// chain (`HTMLElement`, `SVGElement`, `Text`), so `instanceof` and the tree members answer
/// as in a browser. React has no tree of its own to ask, so each node's state keeps its
/// parent and its children in order.

import {
  blurHostElement,
  createElementMethods,
  defineDomMembers,
  defineScrollMembers,
  document,
  DOM_BINDING,
  focusHostElement,
  HOST_BINDING,
  hostElementMatches,
  HTMLElement,
  readBoundingClientRect,
  SVG_CHILD_TYPES,
  SVGElement,
  Text,
} from "@ghia/native/host"
import type {
  BoundingClientRect,
  ElementBinding,
  ElementMethods,
  FocusOptions,
  GetAnimationsOptions,
  HostBinding,
  NodeBinding,
  TextBinding,
} from "@ghia/native/host"
import type { Container, ElementType, Instance, Props, TextInstance } from "../types/host.js"
import { listenersOf } from "./event-registry.js"

export type HostNode = Instance | TextInstance

export interface HostNodeState {
  container: Container
  initialChildren?: HostNode[]
  mounted: boolean
  /**
   * React hid this element (Suspense, Activity). Its native style carries
   * `visibility: hidden`, so a style update must keep that rather than
   * overwrite it with the visible one.
   */
  hidden: boolean
  /** The node it is placed in, or `null` at the top of a window or before it is placed. */
  parent: HostNode | null
  /** The nodes placed in it, in order. */
  children: HostNode[]
  /** The members of its type (`<input>`, `<form>`, ...) were attached when its ref was handed out. */
  typeMembersAttached: boolean
  binding?: NodeBinding
}

const hostNodeStates = new WeakMap<HostNode, HostNodeState>()

export function stateFor(node: HostNode): HostNodeState {
  const state = hostNodeStates.get(node)
  if (!state) {
    throw new Error(`GPUIX host node ${node.nativeId} does not belong to a root`)
  }
  return state
}

export function containerFor(node: HostNode): Container {
  return stateFor(node).container
}

function createState(container: Container): HostNodeState {
  return {
    container,
    mounted: false,
    hidden: false,
    parent: null,
    children: [],
    typeMembersAttached: false,
  }
}

function methodsOf(instance: HostNode): ElementMethods {
  return createElementMethods(containerFor(instance).nativeRenderer, instance.nativeId)
}

class ReactHostElement extends HTMLElement implements Instance {
  declare parentId?: number

  constructor(
    readonly nativeId: number,
    readonly type: ElementType,
    public props: Props
  ) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    const state = stateFor(this)
    const binding = state.binding ?? new ElementDomBinding(this, state)
    state.binding = binding
    return binding as ElementBinding
  }

  setPointerCapture(pointerId: number): void {
    methodsOf(this).setPointerCapture(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    methodsOf(this).releasePointerCapture(pointerId)
  }

  hasPointerCapture(pointerId: number): boolean {
    return methodsOf(this).hasPointerCapture(pointerId)
  }

  click(): void {
    methodsOf(this).click()
  }

  requestPointerLock(): void {
    methodsOf(this).requestPointerLock()
  }

  getAnimations(options?: GetAnimationsOptions) {
    return methodsOf(this).getAnimations.call(this, options)
  }

  focus(options?: FocusOptions): void {
    focusHostElement(containerFor(this).nativeRenderer, this.nativeId, options)
  }

  blur(): void {
    blurHostElement(containerFor(this).nativeRenderer, this.nativeId)
  }

  matches(selector: string): boolean {
    return hostElementMatches(containerFor(this).nativeRenderer, this.nativeId, selector)
  }

  getBoundingClientRect(): BoundingClientRect {
    return readBoundingClientRect(containerFor(this).nativeRenderer, this.nativeId)
  }

  [HOST_BINDING](): HostBinding | undefined {
    const state = stateFor(this)
    return state.mounted
      ? { renderer: state.container.nativeRenderer, mutations: state.container.renderer }
      : undefined
  }
}

defineScrollMembers(ReactHostElement.prototype, (instance: ReactHostElement) => ({
  renderer: containerFor(instance).nativeRenderer,
  id: instance.nativeId,
}))
defineDomMembers(ReactHostElement.prototype, (instance: ReactHostElement) => ({
  listeners: listenersOf(instance),
  connected: isConnected(instance),
  layout: stateFor(instance).mounted
    ? { renderer: containerFor(instance).nativeRenderer, id: instance.nativeId }
    : undefined,
  prop: (name) => (instance.props as Record<string, unknown>)[name],
}))

/** Mounted, which a destroyed element is not any more. */
function isConnected(instance: Instance): boolean {
  return containerFor(instance).instances.get(instance.nativeId) === instance
}

/**
 * What an `<svg>` and its shapes are built from: an `SVGElement` with the members of
 * `ReactHostElement`. Constructed through `ReactHostElement` with this as `new.target`, so
 * the fields come from one constructor and the prototype chain from this one.
 */
abstract class ReactSvgElement extends SVGElement {}
for (const key of Reflect.ownKeys(ReactHostElement.prototype)) {
  if (key === "constructor") continue
  const descriptor = Object.getOwnPropertyDescriptor(ReactHostElement.prototype, key)
  if (descriptor === undefined) throw new Error(`ReactHostElement.prototype has no own ${String(key)}`)
  Object.defineProperty(ReactSvgElement.prototype, key, descriptor)
}

class ReactHostText extends Text implements TextInstance {
  constructor(
    readonly nativeId: number,
    public text: string,
    public parentId: number | null
  ) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    const state = stateFor(this)
    const binding = state.binding ?? new TextDomBinding(this, state)
    state.binding = binding
    return binding as TextBinding
  }
}

class ElementDomBinding implements ElementBinding {
  constructor(
    private readonly instance: ReactHostElement,
    private readonly state: HostNodeState
  ) {}

  /** `<html>` is in the document, which is the top of every mounted tree. */
  get parent(): NodeBinding["parent"] {
    const parent = this.state.parent
    if (parent !== null) return parent
    return this.state.container.html === this.instance ? document : null
  }

  get children(): NodeBinding["children"] {
    return this.state.children
  }

  get connected(): boolean {
    return isConnected(this.instance)
  }

  get root(): object | null {
    return this.state.container
  }

  get type(): string {
    return this.instance.type
  }

  prop(name: string): unknown {
    return (this.instance.props as Record<string, unknown>)[name]
  }

  propNames(): Iterable<string> {
    return Object.keys(this.instance.props)
  }
}

class TextDomBinding implements TextBinding {
  constructor(
    private readonly text: ReactHostText,
    private readonly state: HostNodeState
  ) {}

  get parent(): NodeBinding["parent"] {
    return this.state.parent
  }

  get children(): NodeBinding["children"] {
    return this.state.children
  }

  get connected(): boolean {
    const parent = this.state.parent
    return parent !== null && "type" in parent && isConnected(parent)
  }

  get root(): object | null {
    return this.state.container
  }

  get data(): string {
    return this.text.text
  }
}

export function createHostElement(
  id: number,
  type: ElementType,
  props: Props,
  container: Container
): Instance {
  const instance =
    type === "svg" || SVG_CHILD_TYPES.has(type)
      ? (Reflect.construct(ReactHostElement, [id, type, props], ReactSvgElement) as ReactHostElement)
      : new ReactHostElement(id, type, props)
  hostNodeStates.set(instance, createState(container))
  return instance
}

export function createHostText(id: number, text: string, container: Container): TextInstance {
  const instance = new ReactHostText(id, text, null)
  hostNodeStates.set(instance, createState(container))
  return instance
}

/**
 * Places `child` in `parent` before `before`, or last, taking it out of the parent it was in:
 * React moves a node by placing it again.
 */
export function linkChild(parent: HostNode, child: HostNode, before?: HostNode): void {
  if (before === child) return
  unlinkChild(child)
  const siblings = stateFor(parent).children
  const index = before === undefined ? siblings.length : siblings.indexOf(before)
  if (index < 0) throw new Error(`GPUIX host node ${before?.nativeId} is not a child of node ${parent.nativeId}`)
  siblings.splice(index, 0, child)
  stateFor(child).parent = parent
}

export function unlinkChild(child: HostNode): void {
  const state = stateFor(child)
  const parent = state.parent
  if (parent === null) return
  const siblings = stateFor(parent).children
  const index = siblings.indexOf(child)
  if (index >= 0) siblings.splice(index, 1)
  state.parent = null
}
