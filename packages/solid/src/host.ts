// Host-tree shape is based on jhomra21/gpuix-solid (MIT), stripped to GPUIX's
// native elements and event contract.
import {
  assertSvgPlacement,
  createElementMethods,
  createWebviewMethods,
  defineDomMembers,
  document,
  DOM_BINDING,
  HTMLElement,
  SVG_CHILD_TYPES,
  SVGElement,
  Text,
  defineScrollMembers,
  ElementListeners,
  EVENT_PROP_NAMES,
  blurHostElement,
  eventTypesWithOverrides,
  focusHostElement,
  hostElementMatches,
  forwardsCustomProp,
  isNativeviewHandlerProp,
  HOST_BINDING,
  HOST_MOUNT,
  ROOT_ELEMENT_STYLE,
  ROOT_ELEMENT_TYPES,
  readBoundingClientRect,
  toBoundingClientRect,
  retireMotionBindings,
  SentWrites,
  serializeCustomProp,
  splitMotionStyle,
  syncMotionBindings,
  syncNativeviewListeners,
  unregisterEventHandlers,
  readTextControlSelection,
  requestFormSubmit,
  selectTextControl,
  setTextControlSelectionRange,
} from "@ghia/native/host"
import type {
  Animation,
  Document,
  DomElement,
  ElementBinding,
  ElementMethods,
  GetAnimationsOptions,
  BoundingClientRect,
  ElementType,
  EventHandlerMap,
  FocusOptions,
  HostBinding,
  HostProps,
  ImagePixelsOptions,
  MotionBinding,
  MotionBindingHost,
  MotionValue,
  MotionValueStyle,
  MutationRenderer,
  NativeRenderer,
  NodeBinding,
  SelectionDirection,
  ScrollableElement,
  StyleDesc,
  TextBinding,
  TextControlHost,
  WebviewMethods,
} from "@ghia/native/host"
import type { DomEvent } from "@ghia/native/host"

export type HostNode = HostElement | HostText
export type HostParent = HostRoot | HostElement
export type HostPropertyValue =
  | object
  | string
  | number
  | boolean
  | ((event: DomEvent) => void)
  | null
  | undefined

export function isHostPropertyValue<Value>(
  value: Value
): value is Value & HostPropertyValue {
  const type = typeof value
  return value == null || type === "object" || type === "string" ||
    type === "number" || type === "boolean" || type === "function"
}

export class HostRoot implements MotionBindingHost {
  readonly kind = "root" as const
  readonly motionBindings = new Map<number, MotionBinding>()
  readonly motionReleases: Array<() => void> = []
  /** Nodes taken out of the tree whose element is destroyed at the next flush, unless they are inserted again first. */
  readonly removals = new Set<HostNode>()
  /** Mounted elements by id, for `document.activeElement`. */
  readonly elements = new Map<number, HostElement>()

  readonly mutations: MutationRenderer
  readonly nativeRenderer: NativeRenderer
  readonly eventHandlers: EventHandlerMap
  readonly allocateId: () => number

  /** The window's `<html>`: its native root. A child of this root only in that it is mounted through it. */
  html: HostElement
  /** The `<body>` in `html`, where the app's top-level nodes are. */
  body: HostElement

  constructor(options: {
    mutations: MutationRenderer
    nativeRenderer: NativeRenderer
    eventHandlers: EventHandlerMap
    allocateId: () => number
  }) {
    this.mutations = options.mutations
    this.nativeRenderer = options.nativeRenderer
    this.eventHandlers = options.eventHandlers
    this.allocateId = options.allocateId
    const elements = this.mountDocumentElements()
    this.html = elements.html
    this.body = elements.body
  }

  /** The app's top-level nodes: what `body` holds. */
  get childList(): HostNode[] {
    return this.body.childList
  }

  /** Makes the `<html>` and `<body>` again for a root that was torn down and renders once more. */
  ensureDocumentElements(): void {
    if (this.html.mounted) return
    const elements = this.mountDocumentElements()
    this.html = elements.html
    this.body = elements.body
  }

  /** Destroys `<html>` and `<body>`, once the app's nodes are out of them. */
  destroyDocumentElements(): void {
    this.finishRemovals()
    if (!this.html.mounted) return
    markUnmounted(this.html)
    this.html.parent = null
    this.mutations.destroyElement(this.html.nativeId)
  }

  /** Destroys the removed nodes that stayed out of the tree. Call before each flush. */
  finishRemovals(): void {
    const removed = [...this.removals]
    this.removals.clear()
    for (const node of removed) {
      if (node.parent !== null || !node.mounted) continue
      markUnmounted(node)
      this.mutations.destroyElement(node.nativeId)
    }
  }

  /** Built through the host machinery an app's elements go through, then mounted as the window's root. */
  private mountDocumentElements(): { html: HostElement; body: HostElement } {
    const html = createHostElement(ROOT_ELEMENT_TYPES.html)
    const body = createHostElement(ROOT_ELEMENT_TYPES.body)
    html.style = { ...ROOT_ELEMENT_STYLE }
    body.style = { ...ROOT_ELEMENT_STYLE }
    html.parent = this
    html.childList.push(body)
    body.parent = html
    mount(this, html)
    this.mutations.setRoot(html.nativeId)
    return { html, body }
  }
}

export class HostElement extends HTMLElement {
  readonly kind = "element" as const
  /**
   * The nodes inside it, in order. Not `children`, which is the DOM's: the elements only.
   * Not `childNodes` either, which hands out a copy that cannot corrupt this one.
   */
  readonly childList: HostNode[] = []
  readonly props = new Map<string, HostPropertyValue>()
  parent: HostParent | null = null
  root: HostRoot | null = null
  nativeId = 0
  mounted = false
  style: StyleDesc = {}
  /** Laid over `style` while it is set, however `style` changes: the box a leaving `popLayout` child keeps. */
  pin: StyleDesc | undefined
  /**
   * Held on the instance, not in a module map: the JSX runtime can load a second
   * copy of this module, and the copy that mounts the node must see them.
   */
  readonly mountListeners = new Set<() => void>()
  /** The `style` entries that are motion values, bound while the element is mounted. */
  motionValues: Record<string, MotionValue> | undefined
  readonly sent = new SentWrites()
  /** The event listeners of the element, and its `on*` props among them: see `ElementListeners`. */
  readonly listeners = new ElementListeners()

  private domBinding: ElementBinding | undefined

  constructor(readonly type: ElementType) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    this.domBinding ??= new ElementDomBinding(this)
    return this.domBinding
  }

  /** What the renderer is given: `style` under `pin`. */
  appliedStyle(): StyleDesc {
    return this.pin === undefined ? this.style : { ...this.style, ...this.pin }
  }

  setPin(pin: StyleDesc | undefined): void {
    this.pin = pin
    this.writeStyle()
  }

  /** Queues the applied style unless native already has it. */
  writeStyle(): void {
    if (!this.root || !this.mounted) return
    const style = this.appliedStyle()
    if (this.sent.writesStyle(style)) this.root.mutations.setStyle(this.nativeId, style, this.sent.styleJson)
  }

  setPointerCapture(pointerId: number): void {
    this.methods().setPointerCapture(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.methods().releasePointerCapture(pointerId)
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.methods().hasPointerCapture(pointerId)
  }

  click(): void {
    this.methods().click()
  }

  requestPointerLock(): void {
    this.methods().requestPointerLock()
  }

  focus(options?: FocusOptions): void {
    focusHostElement(this.mountedRenderer("focus"), this.nativeId, options)
  }

  blur(): void {
    blurHostElement(this.mountedRenderer("blur"), this.nativeId)
  }

  matches(selector: string): boolean {
    return hostElementMatches(this.mountedRenderer("matches"), this.nativeId, selector)
  }

  private methods(): ElementMethods {
    if (!this.root) throw new Error("The element is not in a root")
    return createElementMethods(this.root.nativeRenderer, this.nativeId)
  }

  private mountedRenderer(method: string): NativeRenderer {
    if (!this.root || !this.mounted) {
      throw new Error(`Cannot call ${method}() on an element that is not mounted`)
    }
    return this.root.nativeRenderer
  }

  /** `<input>` and `<textarea>` only: select all of the text. */
  select(): void {
    selectTextControl(this.textControl("select()"))
  }

  /** `<input>` and `<textarea>` only. Offsets are UTF-16 code units. */
  setSelectionRange(start: number, end: number, direction?: SelectionDirection): void {
    setTextControlSelectionRange(this.textControl("setSelectionRange()"), start, end, direction)
  }

  /** `<input>` and `<textarea>` only. */
  get selectionStart(): number {
    return readTextControlSelection(this.textControl("selectionStart")).start
  }

  /** `<input>` and `<textarea>` only. */
  get selectionEnd(): number {
    return readTextControlSelection(this.textControl("selectionEnd")).end
  }

  /** `<input>` and `<textarea>` only. */
  get selectionDirection(): SelectionDirection {
    return readTextControlSelection(this.textControl("selectionDirection")).direction
  }

  /** `<webview>` only. See `WebviewMethods`. */
  loadURL(url: string): void {
    this.webview("loadURL()").loadURL(url)
  }

  /** `<webview>` only. */
  reload(): void {
    this.webview("reload()").reload()
  }

  /** `<webview>` only. */
  stop(): void {
    this.webview("stop()").stop()
  }

  /** `<webview>` only. */
  goBack(): void {
    this.webview("goBack()").goBack()
  }

  /** `<webview>` only. */
  goForward(): void {
    this.webview("goForward()").goForward()
  }

  /** `<webview>` only. */
  canGoBack(): boolean {
    return this.webview("canGoBack()").canGoBack()
  }

  /** `<webview>` only. */
  canGoForward(): boolean {
    return this.webview("canGoForward()").canGoForward()
  }

  /** `<webview>` only. */
  getURL(): string {
    return this.webview("getURL()").getURL()
  }

  /** `<webview>` only. */
  getTitle(): string {
    return this.webview("getTitle()").getTitle()
  }

  /** `<webview>` only. */
  executeJavaScript(code: string): Promise<unknown> {
    return this.webview("executeJavaScript()").executeJavaScript(code)
  }

  private webview(member: string): WebviewMethods {
    const root = this.root
    if (!root || !this.mounted) throw new Error(`${member} needs a mounted element`)
    if (this.type !== "webview") {
      throw new Error(`${member} is only valid on <webview>, got <${this.type}>`)
    }
    return createWebviewMethods({
      id: this.nativeId,
      nativeRenderer: root.nativeRenderer,
      flushMutations: () => root.mutations.flushMutations(),
    })
  }

  /** `<form>` only: validate the controls, then submit. */
  requestSubmit(): void {
    const root = this.root
    if (!root || !this.mounted) throw new Error("requestSubmit() needs a mounted element")
    if (this.type !== "form") {
      throw new Error(`requestSubmit() is only valid on <form>, got <${this.type}>`)
    }
    requestFormSubmit({
      id: this.nativeId,
      nativeRenderer: root.nativeRenderer,
      flushMutations: () => root.mutations.flushMutations(),
    })
  }

  private textControl(member: string): TextControlHost {
    const root = this.root
    if (!root || !this.mounted) throw new Error(`${member} needs a mounted element`)
    if (this.type !== "input" && this.type !== "textarea") {
      throw new Error(`${member} is only valid on <input> and <textarea>, got <${this.type}>`)
    }
    return {
      id: this.nativeId,
      nativeRenderer: root.nativeRenderer,
      flushMutations: () => root.mutations.flushMutations(),
    }
  }

  /**
   * The border box in window coordinates, like the DOM. Pending changes are
   * sent and laid out first, so it is never stale. An element that is not
   * mounted, or has no box (not painted), reports a zero rect.
   */
  getBoundingClientRect(): BoundingClientRect {
    if (!this.root || !this.mounted) return toBoundingClientRect(null)
    return readBoundingClientRect(this.root.nativeRenderer, this.nativeId)
  }

  /**
   * The CSS transitions, then the CSS animations, that are running, paused or
   * in effect through a fill, as `Animation` objects. An element that is not
   * mounted has none. With `{ subtree: true }` the elements below are listed
   * too. See `Animation`.
   */
  getAnimations(options?: GetAnimationsOptions): Animation[] {
    if (!this.root || !this.mounted) return []
    return this.methods().getAnimations.call(this, options)
  }

  [HOST_MOUNT](listener: () => void): () => void {
    this.mountListeners.add(listener)
    return () => this.mountListeners.delete(listener)
  }

  [HOST_BINDING](): HostBinding | undefined {
    if (!this.root || !this.mounted) return undefined
    return { renderer: this.root.nativeRenderer, mutations: this.root.mutations }
  }

  setImage(bytes: Buffer | Uint8Array): void {
    this.root?.nativeRenderer.setImage?.(this.nativeId, bytes as Buffer)
  }

  setImagePixels(
    width: number,
    height: number,
    pixels: Buffer | Uint8Array,
    options?: ImagePixelsOptions
  ): void {
    this.root?.nativeRenderer.setImagePixels?.(
      this.nativeId,
      width,
      height,
      pixels as Buffer,
      options?.format
    )
  }
}

/** The DOM scroll members: `scrollTop`, `scrollTo`, `scrollIntoView` and the rest. */
export interface HostElement extends ScrollableElement, Omit<DomElement, "ownerDocument"> {
  /** Narrower than `Node.ownerDocument`: the app's `document`, whose `defaultView` is the window. */
  readonly ownerDocument: DomElement["ownerDocument"]
}
defineDomMembers(HostElement.prototype, (element: HostElement) => ({
  listeners: element.listeners,
  connected: isConnected(element),
  layout: element.root && element.mounted ? { renderer: element.root.nativeRenderer, id: element.nativeId } : undefined,
  prop: (name) => element.props.get(name),
}))
defineScrollMembers(HostElement.prototype, (element: HostElement) => ({
  renderer: element.root?.nativeRenderer,
  id: element.nativeId,
}))

/**
 * What an `<svg>` and its shapes are built from: an `SVGElement` that has the members of
 * `HostElement`. Made by constructing a `HostElement` with this as `new.target`, so the
 * fields come from one constructor and the prototype chain from this one.
 */
abstract class SvgHostElement extends SVGElement {}
for (const key of Reflect.ownKeys(HostElement.prototype)) {
  if (key === "constructor") continue
  const descriptor = Object.getOwnPropertyDescriptor(HostElement.prototype, key)
  if (descriptor === undefined) throw new Error(`HostElement.prototype has no own ${String(key)}`)
  Object.defineProperty(SvgHostElement.prototype, key, descriptor)
}

/** In the tree of a root: every ancestor up to the root still holds it, as `removeChild` takes a node out of the DOM. */
function isConnected(node: HostNode): boolean {
  let current: HostNode | HostRoot = node
  while (current.kind !== "root") {
    if (current.parent === null) return false
    current = current.parent
  }
  return true
}

export class HostText extends Text {
  readonly kind = "text" as const
  readonly childList: HostNode[] = []
  parent: HostParent | null = null
  root: HostRoot | null = null
  nativeId = 0
  mounted = false
  private domBinding: TextBinding | undefined

  constructor(public text: string) {
    super()
  }

  [DOM_BINDING](): TextBinding {
    this.domBinding ??= new TextDomBinding(this)
    return this.domBinding
  }
}

/** `<html>` is in the document, which is the top of every mounted tree. */
function parentNodeOf(node: HostNode): HostElement | Document | null {
  const parent = node.parent
  if (parent === null) return null
  return parent.kind === "root" ? document : parent
}

class ElementDomBinding implements ElementBinding {
  constructor(private readonly element: HostElement) {}

  get parent(): NodeBinding["parent"] {
    return parentNodeOf(this.element)
  }

  get children(): NodeBinding["children"] {
    return this.element.childList
  }

  get connected(): boolean {
    return isConnected(this.element)
  }

  get root(): object | null {
    return this.element.root
  }

  get type(): string {
    return this.element.type
  }

  prop(name: string): unknown {
    return this.element.props.get(name)
  }

  propNames(): Iterable<string> {
    return this.element.props.keys()
  }
}

class TextDomBinding implements TextBinding {
  constructor(private readonly text: HostText) {}

  get parent(): NodeBinding["parent"] {
    return parentNodeOf(this.text)
  }

  get children(): NodeBinding["children"] {
    return this.text.childList
  }

  get connected(): boolean {
    return isConnected(this.text)
  }

  get root(): object | null {
    return this.text.root
  }

  get data(): string {
    return this.text.text
  }
}

export function createHostElement(type: string): HostElement {
  if (!isElementType(type)) throw new Error(`Unsupported GPUIX element <${type}>`)
  if (type === "svg" || SVG_CHILD_TYPES.has(type)) {
    return Reflect.construct(HostElement, [type], SvgHostElement) as HostElement
  }
  return new HostElement(type)
}

function isElementType(type: string): type is ElementType {
  switch (type) {
    case "html":
    case "body":
    case "div":
    case "text":
    case "span":
    case "img":
    case "svg":
    case "canvas":
    case "input":
    case "textarea":
    case "label":
    case "form":
    case "anchored":
    case "code":
    case "diff":
    case "markdown":
    case "webview":
    case "nativeview":
    case "virtual-list":
    case "path":
    case "circle":
    case "ellipse":
    case "rect":
    case "line":
    case "polyline":
    case "polygon":
    case "g":
    case "defs":
    case "linearGradient":
    case "radialGradient":
    case "stop":
    case "clipPath":
    case "mask":
    case "use":
    case "symbol":
    case "pattern":
    case "marker":
    case "image":
    case "tspan":
    case "textPath":
    case "filter":
    case "feBlend":
    case "feColorMatrix":
    case "feComponentTransfer":
    case "feFuncR":
    case "feFuncG":
    case "feFuncB":
    case "feFuncA":
    case "feComposite":
    case "feConvolveMatrix":
    case "feDiffuseLighting":
    case "feDisplacementMap":
    case "feDistantLight":
    case "feDropShadow":
    case "feFlood":
    case "feGaussianBlur":
    case "feImage":
    case "feMerge":
    case "feMergeNode":
    case "feMorphology":
    case "feOffset":
    case "fePointLight":
    case "feSpecularLighting":
    case "feSpotLight":
    case "feTile":
    case "feTurbulence":
      return true
    default:
      return false
  }
}

export function createHostText(value: string): HostText {
  return new HostText(String(value))
}

export function replaceHostText(node: HostText, value: string): void {
  const next = String(value)
  if (node.text === next) return
  node.text = next
  if (node.root && node.mounted) node.root.mutations.setText(node.nativeId, next)
}

// A `<nativeview>`'s handlers take the pointer and nothing, not an event: see `syncNativeviewListeners`.
const EVENT_TYPE_BY_PROP = eventTypesWithOverrides({ onAttach: null, onDetach: null })

function eventTypeFor(name: string): string | undefined {
  return EVENT_TYPE_BY_PROP.get(name)
}

function customPropAllowed(node: HostElement, name: string): boolean {
  return forwardsCustomProp(node.type, name)
}

export function setHostProperty(
  node: HostNode,
  name: string,
  value: HostPropertyValue,
  previous?: HostPropertyValue
): void {
  if (node.kind === "text" || name === "children" || name === "ref" || name === "key") {
    return
  }
  if (name === "style") {
    const split = splitMotionStyle(isStyle(value) ? value : undefined)
    node.style = split.style ?? {}
    node.motionValues = split.motionValues
    if (node.root && node.mounted) {
      node.writeStyle()
      syncMotionBindings(node.root, node.root.mutations, node.nativeId, node.motionValues, node.kind === "element" ? node.type : undefined)
    }
    return
  }
  if (isNativeviewHandlerProp(name)) {
    if (isEventHandler(value)) node.props.set(name, value)
    else node.props.delete(name)
    if (node.root && node.mounted && node.type === "nativeview") syncNativeviewProps(node.root, node)
    return
  }
  const eventType = eventTypeFor(name)
  if (eventType) {
    if (isEventHandler(value)) node.props.set(name, value)
    else node.props.delete(name)
    node.listeners.setProp(eventType, isEventHandler(value) ? value : undefined)
    return
  }
  if (value === undefined) node.props.delete(name)
  else node.props.set(name, value)
  if (!node.root || !node.mounted || !customPropAllowed(node, name)) return
  const serialized = serializeCustomProp(value)
  if (node.sent.writesProp(name, serialized)) node.root.mutations.setCustomProp(node.nativeId, name, serialized)
}

function syncNativeviewProps(root: HostRoot, node: HostElement): void {
  syncNativeviewListeners(
    root.eventHandlers,
    root.mutations,
    node.nativeId,
    node.props.get("onAttach"),
    node.props.get("onDetach")
  )
}

function mount(root: HostRoot, node: HostNode): void {
  if (node.root && node.root !== root) {
    throw new Error("Cannot move a GPUIX host node between roots")
  }
  node.root = root
  if (!node.nativeId) node.nativeId = root.allocateId()
  if (node.mounted) return
  node.mounted = true
  if (node.kind === "element") root.elements.set(node.nativeId, node)
  root.mutations.createElement(node.nativeId, node.kind === "text" ? "text" : node.type)
  if (node.kind === "text") {
    root.mutations.setText(node.nativeId, node.text)
  } else {
    node.sent.reset()
    node.writeStyle()
    if (node.motionValues) syncMotionBindings(root, root.mutations, node.nativeId, node.motionValues, node.type)
    node.listeners.attach({ eventHandlers: root.eventHandlers, renderer: root.mutations, elementId: node.nativeId })
    for (const [name, value] of node.props) {
      if (!EVENT_PROP_NAMES.has(name) && customPropAllowed(node, name)) {
        const serialized = serializeCustomProp(value)
        if (node.sent.writesProp(name, serialized)) root.mutations.setCustomProp(node.nativeId, name, serialized)
      }
    }
    if (node.type === "nativeview") syncNativeviewProps(root, node)
  }
  if (node.kind === "element") {
    if (node.mountListeners.size > 0) for (const listener of [...node.mountListeners]) listener()
  }
  for (const child of node.childList) {
    mount(root, child)
    root.mutations.appendChild(node.nativeId, child.nativeId)
  }
}

function removeFromParent(node: HostNode): void {
  const parent = node.parent
  if (!parent) return
  const index = parent.childList.indexOf(node)
  if (index >= 0) parent.childList.splice(index, 1)
  node.parent = null
}

export function insertHostNode(
  requestedParent: HostParent,
  node: HostNode,
  requestedAnchor?: HostNode | null
): void {
  // The app's top-level nodes are `body`'s.
  const parent = requestedParent.kind === "root" ? requestedParent.body : requestedParent
  // Like the DOM, inserting a node before itself leaves it where it is. Solid's
  // list reconcile does it when it swaps two neighbours.
  const anchor = requestedAnchor === node ? getNextSibling(node) : requestedAnchor
  if (anchor && anchor.parent !== parent) {
    throw new Error("GPUIX Solid anchor is not a child of its parent")
  }
  if (node.kind === "element") assertSvgPlacement(parent.type, node.type)
  removeFromParent(node)
  const index = anchor ? parent.childList.indexOf(anchor) : parent.childList.length
  parent.childList.splice(index, 0, node)
  node.parent = parent
  const root = parent.root
  if (!root) return
  root.removals.delete(node)
  mount(root, node)
  if (anchor) root.mutations.insertBefore(parent.nativeId, node.nativeId, anchor.nativeId)
  else root.mutations.appendChild(parent.nativeId, node.nativeId)
}

function markUnmounted(node: HostNode): void {
  node.mounted = false
  if (node.root) {
    // A `<nativeview>` hears `detach` while the batch that destroys it is applied, which is
    // after this: it stays known until `createRoot` releases the destroyed ids.
    if (!(node.kind === "element" && node.type === "nativeview")) {
      node.root.elements.delete(node.nativeId)
      if (node.kind === "element") node.listeners.detach()
      unregisterEventHandlers(node.root.eventHandlers, node.nativeId)
    }
    // Retired now, released after the batch: an element mounted again before
    // the flush binds its values afresh, and a shared value is never freed between.
    if (node.root.motionBindings.size > 0) retireMotionBindings(node.root, [node.nativeId])
  }
  for (const child of node.childList) markUnmounted(child)
}

/**
 * Solid moves a node by removing it and inserting it again (`replaceChild`).
 * Destroying the element on removal would recreate it: its focus, pointer
 * capture and layout animation would be gone. It is destroyed when the
 * batch is flushed, unless the node came back.
 */
export function removeHostNode(requestedParent: HostParent, node: HostNode): void {
  const parent = requestedParent.kind === "root" ? requestedParent.body : requestedParent
  if (node.parent !== parent) return
  removeFromParent(node)
  const root = parent.root
  if (!root || !node.mounted) return
  root.removals.add(node)
  // Native is told now, not at the flush: a layout read in this turn flushes the queue and
  // must not lay out a subtree the DOM would already have taken out of the document.
  root.mutations.detachChild(node.nativeId)
  root.mutations.requestFlush()
}

export function getParentNode(node: HostNode): HostParent | undefined {
  return node.parent ?? undefined
}

export function getFirstChild(parent: HostParent): HostNode | undefined {
  return parent.childList[0]
}

export function getNextSibling(node: HostNode): HostNode | undefined {
  const parent = node.parent
  if (!parent) return undefined
  const index = parent.childList.indexOf(node)
  return index < 0 ? undefined : parent.childList[index + 1]
}

export function isHostText(node: HostNode | HostParent): node is HostText {
  return node.kind === "text"
}

/** Structural, not `instanceof`: a JSX file compiled against the published
 *  package and a component from source build nodes from two class copies. */
export function isHostElement(value: unknown): value is HostElement {
  return typeof value === "object" && value !== null &&
    (value as { kind?: unknown }).kind === "element"
}

function isEventHandler(
  value: HostPropertyValue
): value is (event: DomEvent) => void {
  return typeof value === "function"
}

function isStyle(value: HostPropertyValue): value is StyleDesc {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export type SolidHostProps = Omit<HostProps, "style"> & {
  style?: MotionValueStyle
  children?: unknown
  ref?: (element: HostElement) => void
}
