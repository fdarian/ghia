// Host-tree shape is based on jhomra21/gpuix-solid (MIT), stripped to GPUIX's
// native elements and event contract.
import {
  applyStyleChange,
  assertSvgPlacement,
  createElementMethods,
  createWebviewMethods,
  crossRootError,
  defineDomMembers,
  document,
  DOM_BINDING,
  HTMLElement,
  SVGElement,
  Text,
  defineScrollMembers,
  ElementListeners,
  EVENT_PROP_NAMES,
  blurHostElement,
  eventTypesWithOverrides,
  focusHostElement,
  attributeText,
  attributesWritten,
  isSvgType,
  isNotNativeAttribute,
  forwardsCustomProp,
  isElementType,
  isNativeviewHandlerProp,
  HOST_BINDING,
  HOST_MOUNT,
  copyPrototypeMembers,
  applyWrittenInputState,
  writtenInputValue,
  queueCharacterDataMutation,
  queueChildListMutation,
  recordAttributeChanges,
  ROOT_ELEMENT_TYPES,
  runAll,
  runSteps,
  readBoundingClientRect,
  toBoundingClientRect,
  retireMotionBindings,
  SentWrites,
  writePopoverAttribute,
  serializeCustomProp,
  splitMotionStyle,
  syncMotionBindings,
  syncNativeviewListeners,
  unregisterEventHandlers,
  readTextControlSelection,
  UnmountedTextSelection,
  requestFormSubmit,
  selectTextControl,
  setTextControlSelectionRange,
} from "@ghia/native/host"
import type {
  AnimateOptions,
  Animation,
  Document,
  DomElement,
  InputMembers,
  Element as DomNodeElement,
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
  KeyframesInput,
  MotionBinding,
  MotionBindingHost,
  MotionValue,
  MotionValueStyle,
  MutationRenderer,
  NativeRenderer,
  Node,
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

interface ClassSources {
  class: HostPropertyValue
  className: HostPropertyValue
  classList: object | undefined
  /** The `class:name={on}` props: the universal Solid compiler passes each as a prop of that name. */
  readonly toggles: Map<string, boolean>
  /** The `classList` keys that were ever truthy: Solid's DOM `classList` takes a token away only from a key it turned on. */
  readonly turnedOn: Set<string>
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
  /** The `<head>` in `html`, before `body`. */
  head: HostElement
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
    this.head = elements.head
    this.body = elements.body
  }

  /** The app's top-level nodes: what `body` holds. */
  get childList(): HostNode[] {
    return this.body.childList
  }

  /** Makes the `<html>`, `<head>` and `<body>` again for a root that was torn down and renders once more. */
  ensureDocumentElements(): void {
    if (this.html.mounted) return
    const elements = this.mountDocumentElements()
    this.html = elements.html
    this.head = elements.head
    this.body = elements.body
  }

  /** Destroys `<html>` and, with it, `<head>` and `<body>`, once the app's nodes are out of them. Releases both even when one throws. */
  destroyDocumentElements(): void {
    runSteps([
      () => this.finishRemovals(),
      () => this.destroyHtml(),
    ], "Tearing down the document failed")
  }

  private destroyHtml(): void {
    if (!this.html.mounted) return
    // If markUnmounted throws partway, the descendants it did not reach keep `mounted = true` while
    // their native elements are destroyed: accepted, the alternative is leaking the native tree.
    try {
      markUnmounted(this.html)
    } finally {
      this.html.parent = null
      this.mutations.destroyElement(this.html.nativeId)
    }
  }

  /** Destroys the removed nodes that stayed out of the tree, each one even when another throws. Call before each flush. */
  finishRemovals(): void {
    const removed = [...this.removals]
    this.removals.clear()
    runAll(removed, (node) => {
      if (!node.mounted || isConnected(node)) return
      // A throw while marking a subtree unmounted must not keep its native elements alive. The
      // descendants it did not reach keep `mounted = true` while their native element is destroyed: accepted.
      try {
        markUnmounted(node)
      } finally {
        this.mutations.destroyElement(node.nativeId)
      }
    }, "Releasing removed nodes failed")
  }

  /** Built through the host machinery an app's elements go through, then mounted as the window's root. */
  private mountDocumentElements(): { html: HostElement; head: HostElement; body: HostElement } {
    const html = createHostElement(ROOT_ELEMENT_TYPES.html)
    const head = createHostElement(ROOT_ELEMENT_TYPES.head)
    const body = createHostElement(ROOT_ELEMENT_TYPES.body)
    html.parent = this
    for (const child of [head, body]) {
      html.childList.push(child)
      child.parent = html
    }
    mount(this, html)
    this.mutations.setRoot(html.nativeId)
    return { html, head, body }
  }
}

/** `Symbol.for`, so a node built by a second copy of this module is still one. */
const HOST_NODE = Symbol.for("@ghia/solid/host-node")

export class HostElement extends HTMLElement {
  readonly kind = "element" as const
  readonly [HOST_NODE] = true
  /**
   * The nodes inside it, in order. Not `children`, which is the DOM's: the elements only.
   * Not `childNodes` either, which hands out a copy that cannot corrupt this one.
   */
  readonly childList: HostNode[] = []
  readonly props = new Map<string, HostPropertyValue>()
  /** What `class`, `className` and `classList` were each given, once more than one of them is in play: see `mergeClassProp`. */
  classSources: ClassSources | undefined
  private detachedSelection: UnmountedTextSelection | undefined
  parent: HostParent | null = null
  root: HostRoot | null = null
  nativeId = 0
  mounted = false
  /**
   * The style the element has: what the framework rendered into `style` and what code wrote through
   * `element.style`, as one. Never changed in place.
   */
  liveStyle: StyleDesc = {}
  /**
   * The style the framework rendered last, kept once code wrote to the style: `liveStyle` is then
   * not it, and the framework's next change is applied as a difference from this onto `liveStyle`.
   * `undefined` while code has not written, when `liveStyle` is the framework's own.
   */
  private frameworkStyle: StyleDesc | undefined
  /** Laid over `liveStyle` while it is set, however `liveStyle` changes: the box a leaving `popLayout` child keeps. */
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

  constructor(readonly elementType: ElementType) {
    super()
  }

  [DOM_BINDING](): ElementBinding {
    this.domBinding ??= new ElementDomBinding(this)
    return this.domBinding
  }

  /** What the renderer is given: `liveStyle` under `pin`. */
  appliedStyle(): StyleDesc {
    return this.pin === undefined ? this.liveStyle : { ...this.liveStyle, ...this.pin }
  }

  /** The framework's `style` prop. Until code writes a style it replaces the live one. */
  setFrameworkStyle(next: StyleDesc): void {
    if (this.frameworkStyle === undefined) {
      this.liveStyle = next
      return
    }
    this.liveStyle = applyStyleChange(this.liveStyle, this.frameworkStyle, next)
    this.frameworkStyle = next
  }

  /** A write from code: `next` is the whole live style. */
  setCodeStyle(next: StyleDesc): void {
    this.frameworkStyle ??= this.liveStyle
    this.liveStyle = next
    // A burst of writes (a drag writing the transform on every pointer move) is one `setStyle` for the next flush.
    if (this.root) this.root.mutations.deferWrite(this, () => this.writeStyle())
    else this.writeStyle()
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
    focusHostElement(this, options)
  }

  blur(): void {
    blurHostElement(this.mountedRenderer(), this.nativeId)
  }

  private methods(): ElementMethods {
    if (!this.root) throw new Error("The element is not in a root")
    return createElementMethods(this.root.nativeRenderer, this.nativeId)
  }

  private mountedRenderer(): NativeRenderer | undefined {
    return this.root && this.mounted ? this.root.nativeRenderer : undefined
  }

  /** `<input>` and `<textarea>` only: select all of the text. */
  select(): void {
    if (!this.mountedControl()) this.unmountedSelection("select()").select()
    else selectTextControl(this.textControl("select()"))
  }

  /** `<input>` and `<textarea>` only. Offsets are UTF-16 code units. */
  setSelectionRange(start: number, end: number, direction?: SelectionDirection): void {
    if (!this.mountedControl()) this.unmountedSelection("setSelectionRange()").setRange(start, end, direction)
    else setTextControlSelectionRange(this.textControl("setSelectionRange()"), start, end, direction)
  }

  /** `<input>` and `<textarea>` only. */
  get selectionStart(): number | null {
    return this.mountedControl()
      ? readTextControlSelection(this.textControl("selectionStart")).start
      : this.unmountedSelection("selectionStart").read().start
  }

  /** `<input>` and `<textarea>` only. */
  get selectionEnd(): number | null {
    return this.mountedControl()
      ? readTextControlSelection(this.textControl("selectionEnd")).end
      : this.unmountedSelection("selectionEnd").read().end
  }

  /** `<input>` and `<textarea>` only. */
  get selectionDirection(): SelectionDirection | null {
    return this.mountedControl()
      ? readTextControlSelection(this.textControl("selectionDirection")).direction
      : this.unmountedSelection("selectionDirection").read().direction
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
    if (this.elementType !== "webview") {
      throw new Error(`${member} is only valid on <webview>, got <${this.elementType}>`)
    }
    return createWebviewMethods({
      id: this.nativeId,
      nativeRenderer: root.nativeRenderer,
      flushMutations: () => root.mutations.flushMutations(),
    })
  }

  /** `<form>` only: validate the controls, then submit. */
  requestSubmit(submitter?: object | null): void {
    const root = this.root
    if (!root || !this.mounted) throw new Error("requestSubmit() needs a mounted element")
    if (this.elementType !== "form") {
      throw new Error(`requestSubmit() is only valid on <form>, got <${this.elementType}>`)
    }
    requestFormSubmit(
      {
        id: this.nativeId,
        nativeRenderer: root.nativeRenderer,
        flushMutations: () => root.mutations.flushMutations(),
      },
      submitter,
    )
  }

  private mountedControl(): boolean {
    return this.root !== null && this.mounted
  }

  /** The selection a control keeps until it is mounted; see `UnmountedTextSelection`. */
  private unmountedSelection(member: string): UnmountedTextSelection {
    if (this.elementType !== "input" && this.elementType !== "textarea") {
      throw new Error(`${member} is only valid on <input> and <textarea>, got <${this.elementType}>`)
    }
    this.detachedSelection ??= new UnmountedTextSelection({
      inputType: () => this.props.get("type"),
      text: () => {
        const written = writtenInputValue(this) ?? this.props.get("value") ?? this.props.get("defaultValue")
        return written === undefined ? "" : String(written)
      },
      valueWritten: () => writtenInputValue(this) !== undefined || this.props.get("value") !== undefined,
    })
    return this.detachedSelection
  }

  private textControl(member: string): TextControlHost {
    const root = this.root
    if (!root || !this.mounted) throw new Error(`${member} needs a mounted element`)
    if (this.elementType !== "input" && this.elementType !== "textarea") {
      throw new Error(`${member} is only valid on <input> and <textarea>, got <${this.elementType}>`)
    }
    return {
      id: this.nativeId,
      nativeRenderer: root.nativeRenderer,
      flushMutations: () => root.mutations.flushMutations(),
      inputType: () => this.props.get("type"),
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
    if (!this.root || !this.mounted || !isConnected(this)) return []
    return this.methods().getAnimations.call(this, options)
  }

  animate(keyframes: KeyframesInput, options?: number | AnimateOptions): Animation {
    return this.methods().animate.call(this, keyframes, options)
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
export interface HostElement extends ScrollableElement, Omit<DomElement, "ownerDocument">, Partial<InputMembers> {
  /** Narrower than `Node.ownerDocument`: the app's `document`, whose `defaultView` is the window. */
  readonly ownerDocument: DomElement["ownerDocument"]
}
defineDomMembers(HostElement.prototype, (element: HostElement) => ({
  listeners: element.listeners,
  get connected() {
    return isConnected(element)
  },
  layout: element.root && element.mounted ? { renderer: element.root.nativeRenderer, id: element.nativeId } : undefined,
  prop: (name) => element.props.get(name),
  propNames: () => element.props.keys(),
  setProp: (name, value) => {
    setHostProperty(element, name, value)
    if (element.root && element.mounted) element.root.mutations.flushMutations()
  },
  get style() {
    return element.liveStyle
  },
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
copyPrototypeMembers(HostElement.prototype, SvgHostElement.prototype)

/** In the tree of a root: every ancestor up to the root still holds it, as `removeChild` takes a node out of the DOM. */
function isConnected(node: HostNode): boolean {
  return treeRoot(node) !== null
}

export class HostText extends Text {
  readonly kind = "text" as const
  readonly [HOST_NODE] = true
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
    return this.element.elementType
  }

  prop(name: string): unknown {
    return this.element.props.get(name)
  }

  propNames(): Iterable<string> {
    return this.element.props.keys()
  }

  get style(): StyleDesc {
    return this.element.liveStyle
  }

  setStyle(next: StyleDesc): void {
    recordAttributeChanges(this.element, () => ["style"], () => this.element.setCodeStyle(next))
  }

  setProp(name: string, value: string): void {
    setHostProperty(this.element, name, value)
  }

  get native(): ElementBinding["native"] {
    const element = this.element
    return element.root && element.mounted ? { renderer: element.root.nativeRenderer, id: element.nativeId } : undefined
  }

  assertSameWindow(child: Node): void {
    const target = crossRootTarget(this.element)
    if (target !== null && belongsToOtherRoot(child as unknown as HostNode, target)) throw crossRootError()
  }

  insertBefore(child: Node, before: Node | null): void {
    this.assertSameWindow(child)
    insertHostNode(this.element, child as unknown as HostNode, before as unknown as HostNode | null)
  }

  removeChild(child: Node): void {
    removeHostNode(this.element, child as unknown as HostNode)
  }

  createText(data: string): Text {
    return createHostText(data)
  }

  createElement(type: string): DomNodeElement {
    return createHostElement(type) as unknown as DomNodeElement
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

  setData(data: string): void {
    replaceHostText(this.text, data)
  }

  createText(data: string): Text {
    return createHostText(data)
  }
}

export function createHostElement(type: string): HostElement {
  if (!isElementType(type)) throw new Error(`Unsupported GPUIX element <${type}>`)
  if (isSvgType(type)) {
    return Reflect.construct(HostElement, [type], SvgHostElement) as HostElement
  }
  return new HostElement(type)
}

export function createHostText(value: string): HostText {
  return new HostText(String(value))
}

export function replaceHostText(node: HostText, value: string): void {
  const next = String(value)
  if (node.text === next) return
  const previous = node.text
  node.text = next
  queueCharacterDataMutation(node, previous)
  if (node.root && node.mounted) node.root.mutations.setText(node.nativeId, next)
}

// A `<nativeview>`'s handlers take the pointer and nothing, not an event: see `syncNativeviewListeners`.
const EVENT_TYPE_BY_PROP = eventTypesWithOverrides({ onAttach: null, onDetach: null })

function eventTypeFor(name: string): string | undefined {
  return EVENT_TYPE_BY_PROP.get(name)
}

function customPropAllowed(node: HostElement, name: string): boolean {
  return forwardsCustomProp(node.elementType, name)
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
    const next = split.style ?? {}
    recordAttributeChanges(node, () => ["style"], () => node.setFrameworkStyle(next))
    node.motionValues = split.motionValues
    if (node.root && node.mounted) {
      node.writeStyle()
      syncMotionBindings(node.root, node.root.mutations, node.nativeId, node.motionValues, node.kind === "element" ? node.elementType : undefined, node.liveStyle)
    }
    return
  }
  if (isNativeviewHandlerProp(name)) {
    if (isEventHandler(value)) node.props.set(name, value)
    else node.props.delete(name)
    if (node.root && node.mounted && node.elementType === "nativeview") syncNativeviewProps(node.root, node)
    return
  }
  const eventType = eventTypeFor(name)
  if (eventType) {
    if (isEventHandler(value)) node.props.set(name, value)
    else node.props.delete(name)
    node.listeners.setProp(eventType, isEventHandler(value) ? value : undefined)
    return
  }
  if (mergesClass(node, name)) {
    setMergedClass(node, name, value)
    return
  }
  if (name === "popover" && node.props.get(name) !== value) {
    // A showing popover whose prop changed closes, with its events, once the prop is stored and sent.
    writePopoverAttribute(node, () => storeAndSyncProp(node, name, value))
    return
  }
  storeAndSyncProp(node, name, value)
}

function storeAndSyncProp(node: HostElement, name: string, value: HostPropertyValue): void {
  recordAttributeChanges(node, () => [name], () => storeHostProp(node, name, value))
  syncStoredProp(node, name, value)
}

function syncStoredProp(node: HostElement, name: string, value: HostPropertyValue): void {
  if (!node.root || !node.mounted) return
  syncAttribute(node.root, node, name, value)
  if (!customPropAllowed(node, name)) return
  const serialized = serializeCustomProp(value)
  if (node.sent.writesProp(name, serialized)) node.root.mutations.setCustomProp(node.nativeId, name, serialized)
}

/** Whether `name` is a prop whose value joins the element's one `class` attribute with another's. */
function mergesClass(node: HostElement, name: string): boolean {
  if (name === "classList" || name.startsWith("class:")) return true
  if (node.classSources !== undefined) return name === "class" || name === "className"
  return (name === "class" && node.props.has("className")) || (name === "className" && node.props.has("class"))
}

/**
 * `class`, `className` and `classList` all end in the one `class` attribute, which is what `props` then
 * holds under `class`, so `getAttribute`, `className` and the sent attribute agree. `class` wins over
 * `className` as in `attributesOfProps`. `classList` and `class:name` are what Solid's DOM
 * `classList` does to the tokens: a truthy key adds its token, and a key that was truthy and is not any more takes it away.
 */
function setMergedClass(node: HostElement, name: string, value: HostPropertyValue): void {
  const sources = (node.classSources ??= {
    class: node.props.get("class"),
    className: node.props.get("className"),
    classList: undefined,
    toggles: new Map(),
    turnedOn: new Set(),
  })
  if (name === "classList") sources.classList = typeof value === "object" && value !== null ? value : undefined
  else if (name.startsWith("class:")) sources.toggles.set(name.slice("class:".length), Boolean(value))
  else if (name === "class") sources.class = value
  else sources.className = value
  const merged = classValueOf(sources)
  const store = () => {
    node.props.delete("className")
    storeHostProp(node, "class", merged)
  }
  recordAttributeChanges(node, () => ["class"], store)
  syncStoredProp(node, "class", merged)
}

function classValueOf(sources: ClassSources): string | undefined {
  const written = sources.class !== undefined ? sources.class : sources.className
  const base = attributeText("class", written)
  if (sources.classList === undefined && sources.toggles.size === 0) return base ?? undefined
  let tokens = base === null ? [] : tokensOf(base)
  let changed = false
  const listed: Array<[string, unknown]> = sources.classList === undefined ? [] : Object.entries(sources.classList)
  const toggles = [...listed, ...sources.toggles]
  for (const [key, on] of toggles) {
    for (const token of tokensOf(key)) {
      if (on) {
        sources.turnedOn.add(token)
        if (!tokens.includes(token)) {
          tokens.push(token)
          changed = true
        }
      } else if (sources.turnedOn.has(token) && tokens.includes(token)) {
        tokens = tokens.filter((existing) => existing !== token)
        changed = true
      }
    }
  }
  return changed ? tokens.join(" ") : (base ?? undefined)
}

function tokensOf(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== "")
}

function syncAttribute(root: HostRoot, node: HostElement, prop: string, value: HostPropertyValue): void {
  // The record of what was sent is filled when the gate opens (`ElementSource.rememberAttributes`).
  if (!root.mutations.forwardsAttributes || isNotNativeAttribute(prop)) return
  for (const [attribute, text] of attributesWritten(node.elementType, prop, value, (name) => node.props.get(name))) {
    if (node.sent.writesAttribute(attribute, text)) root.mutations.setAttribute(node.nativeId, attribute, text)
  }
}

function storeHostProp(node: HostElement, name: string, value: HostPropertyValue): void {
  if (value === undefined) node.props.delete(name)
  else node.props.set(name, value)
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
  root.mutations.createElement(node.nativeId, node.kind === "text" ? "#text" : node.elementType)
  if (node.kind === "text") {
    root.mutations.setText(node.nativeId, node.text)
  } else {
    node.sent.reset()
    node.writeStyle()
    if (node.motionValues) syncMotionBindings(root, root.mutations, node.nativeId, node.motionValues, node.elementType, node.liveStyle)
    node.listeners.attach({ eventHandlers: root.eventHandlers, renderer: root.mutations, elementId: node.nativeId })
    for (const [name, value] of node.props) {
      syncAttribute(root, node, name, value)
      if (!EVENT_PROP_NAMES.has(name) && customPropAllowed(node, name)) {
        const serialized = serializeCustomProp(value)
        if (node.sent.writesProp(name, serialized)) root.mutations.setCustomProp(node.nativeId, name, serialized)
      }
    }
    if (node.elementType === "nativeview") syncNativeviewProps(root, node)
    if (node.elementType === "input" || node.elementType === "textarea") applyWrittenInputState(node)
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
  if (index >= 0 && parent.kind === "element") {
    queueChildListMutation(parent, [], [node], parent.childList[index - 1] ?? null, parent.childList[index] ?? null)
  }
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
  if (node.kind === "element") assertSvgPlacement(parent.elementType, node.elementType)
  removeFromParent(node)
  const index = anchor ? parent.childList.indexOf(anchor) : parent.childList.length
  parent.childList.splice(index, 0, node)
  node.parent = parent
  queueChildListMutation(parent, [node], [], parent.childList[index - 1] ?? null, parent.childList[index + 1] ?? null)
  const root = parent.mounted ? parent.root : null
  if (root === null) {
    // The new parent has no native element (it was never mounted, or was released), so a node
    // moved into it leaves native's tree too.
    retireNode(node)
    return
  }
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
    if (!(node.kind === "element" && node.elementType === "nativeview")) {
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
  retireNode(node)
}

/**
 * Takes a mounted node out of native's tree and leaves it to `finishRemovals`, which releases it
 * unless it is in a connected tree again by then.
 */
function retireNode(node: HostNode): void {
  const root = node.root
  if (!root || !node.mounted) return
  root.removals.add(node)
  // Native is told now, not at the flush: a layout read in this turn flushes the queue and
  // must not lay out a subtree the DOM would already have taken out of the document.
  root.mutations.detachChild(node.nativeId)
  root.mutations.requestFlush()
}

/**
 * Whether `node`, or a node under it, was mounted by a root other than `target`: mounting it there
 * would throw after the tree was changed. A mounted node's subtree is in its own root already.
 */
function belongsToOtherRoot(node: HostNode, target: HostRoot): boolean {
  if (node.root !== null && node.root !== target) return true
  if (node.mounted || node.kind !== "element") return false
  return node.childList.some((child) => belongsToOtherRoot(child, target))
}

/**
 * The root a node put into `parent` has to belong to: `parent`'s own while it has a native element,
 * which holds for a parent that code took out of the document this turn and native has not yet
 * released; else the root of the tree it is in.
 */
function crossRootTarget(parent: HostNode): HostRoot | null {
  return parent.mounted ? parent.root : treeRoot(parent)
}

/** The root whose tree `node` is in, or `null` for a node that is in none. */
function treeRoot(node: HostNode): HostRoot | null {
  let current: HostNode | HostRoot = node
  while (current.kind !== "root") {
    if (current.parent === null) return null
    current = current.parent
  }
  return current
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

export function isHostElement(value: unknown): value is HostElement {
  return isHostNode(value) && value.kind === "element"
}

/** A host element or text node, as opposed to any other value a component can render, an app's own `{ kind: "text" }` among them. */
export function isHostNode(value: unknown): value is HostNode {
  return typeof value === "object" && value !== null && HOST_NODE in value
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
