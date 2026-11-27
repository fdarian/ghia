import type { EventPayload } from "../../index.js"
import type { FocusableElement } from "../focus.js"
import type { NativeRenderer } from "../host.js"
import type { Animation } from "../web-animations.js"
import { isElementType, isSvgElementType } from "../dom/element-types.js"
import {
  adoptSubtree,
  crossRootError,
  Document,
  DOM_BINDING,
  makerDocumentOf,
  Node,
  ownerDocumentOf,
  registerDocument,
  type DocumentFragment,
  type HTMLElement,
  type NodeBinding,
  type Text,
} from "../dom/nodes.js"
import { createAdoptedStyleSheets, setAdoptedSheets, type CSSStyleSheet } from "../css/index.js"
import { Range } from "../dom/range.js"
import { createCaretPosition, type CaretPosition } from "../editing/caret-position.js"
import { documentCommands } from "../editing/document-commands.js"
import { caretFromPoint, setElementLookup } from "../editing/geometry.js"
import { createSelection, holdsNodeSelection, type Selection } from "../dom/selection.js"
import { bumpTreeVersion } from "../dom/tree-version.js"
import { createTreeWalker, type NodeFilterLike, type TreeWalker } from "../dom/tree-walker.js"
import {
  createDomEvent,
  EVENT_PHASE_AT_TARGET,
  EVENT_PHASE_BUBBLING,
  EVENT_PHASE_CAPTURING,
  EVENT_PHASE_NONE,
  dispatchDomEvent,
  type DomDispatchHooks,
  type DomDispatchResult,
  type DomEvent,
  type DomEventRoot,
  type DomEventState,
  type HandlersAt,
  reportHandlerErrors,
  reportUncaught,
  walkDomEvent,
} from "./dispatch.js"
import { dispatchStateOf, type DispatchState } from "./event-state.js"
import { GpuixEventTarget, type AddEventListenerOptions, type WindowEventListener } from "./event-target.js"
import { GpuixWindow } from "./window-targets.js"

export { GpuixEventTarget, type AddEventListenerOptions, type WindowEventListener } from "./event-target.js"

/**
 * Kept on `globalThis` like the element sources: the module that makes `Animation` objects
 * (`web-animations`) imports this one, so it hands `document` the way to list a renderer's.
 */
const DOCUMENT_ANIMATIONS_KEY = Symbol.for("@ghia/native/document-animations")

const typeSubscribers = new Set<() => void>()
const notifyTypeSubscribers = () => {
  for (const subscriber of [...typeSubscribers]) subscriber()
}

/**
 * What a root tells the rest of the runtime about its elements: `document` asks
 * it for `activeElement`, and event dispatch asks it for `target`,
 * `currentTarget` and `relatedTarget`.
 */
type ElementSource = {
  /** Id of the element that holds focus in the root's window, or `null`. */
  focusedId(): number | null
  /** Id of the element that holds the pointer lock in the root's window, or `null`. */
  pointerLockId(): number | null
  /** The object the adapter hands out for that element (a ref's value), or `undefined` once the root has dropped it. */
  elementById(id: number): object | undefined
  /** The `<html>`, `<head>` and `<body>` elements the root's adapter made for its window, or `null` for a source that has none. */
  documentElements(): DocumentElements | null
  /** Makes the nodes of the root's window, or `null` for a source that has no way to. */
  nodeFactory: DomNodeFactory | null
}

/**
 * How an adapter makes the nodes `document.createElement` and `document.createTextNode` hand out
 * for its window: its own element and text classes, in no tree yet and not known to native until
 * they are inserted under a connected node.
 */
export type DomNodeFactory = {
  /** `type` is one of the element types, as written: `isElementType` has checked it. */
  createElement(type: string): object
  createTextNode(data: string): Text
  /** An empty `DocumentFragment`: never mounted, it holds children through the same mirror an element does. */
  createDocumentFragment(): object
}

/** The elements every window root is made of: `html`, with `head` and `body` in it, the latter holding the app. */
export type DocumentElements = {
  html: object
  head: object
  body: object
}

type ElementSourceEntry = {
  source: ElementSource
  /** The renderer's window was replaced or closed: it can still name elements but reports no focus and lists no animations. */
  windowGone: boolean
  /** Order in which the roots last heard a focus event; higher is more recent. */
  focusedAt: number
  /** The element the last `focusin` named, until its `focusout`: what `document.activeElement` answers without asking native. */
  focused: object | null
}

/**
 * Kept on `globalThis`, like the renderer states: under `bun --hot` this module
 * is evaluated again while a renderer's state, which asks it for elements on
 * every event, stays from the first evaluation.
 */
const ELEMENT_SOURCES_KEY = Symbol.for("@ghia/native/element-sources")
const elementSources: Map<object, ElementSourceEntry> = (() => {
  const existing = Reflect.get(globalThis, ELEMENT_SOURCES_KEY) as Map<object, ElementSourceEntry> | undefined
  if (existing) return existing
  const created = new Map<object, ElementSourceEntry>()
  Reflect.set(globalThis, ELEMENT_SOURCES_KEY, created)
  return created
})()
let focusClock = 0

type StandInDocument = {
  /** The `<html>`, `<head>` and `<body>` a document answers with while no root of its window is mounted. */
  elements: (document: GpuixDocument) => DocumentElements
  /** A root of the document's window mounted: the stand-ins give what was written to them to its elements and stop being the document's. */
  replace: (document: GpuixDocument, mounted: DocumentElements) => void
}

let standInDocument: StandInDocument | undefined

/**
 * Registers the stand-in `<html>`, `<head>` and `<body>`. They are built from the element classes,
 * which load this module, so `dom-globals.ts` hands them over instead of this module importing them.
 */
export function installStandInDocument(stand: StandInDocument): void {
  standInDocument = stand
}

function installedStandIn(): StandInDocument {
  if (standInDocument === undefined) {
    throw new Error("The stand-in document is not installed: import @ghia/native/host before reading document.documentElement")
  }
  return standInDocument
}

const XML_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml"
const SVG_NAMESPACE = "http://www.w3.org/2000/svg"

function assertElementName(name: string, method: string): void {
  if (!XML_NAME.test(name)) {
    throw new DOMException(`Failed to execute '${method}' on 'Document': The tag name provided ('${name}') is not a valid name.`, "InvalidCharacterError")
  }
}

function unsupportedElement(name: string, method: string): DOMException {
  return new DOMException(`Failed to execute '${method}' on 'Document': <${name}> is not an element Ghia draws.`, "NotSupportedError")
}

function finiteCoordinate(value: number, name: string): number {
  const coordinate = Number(value)
  if (!Number.isFinite(coordinate)) {
    throw new TypeError(`Failed to execute 'elementsFromPoint' on 'Document': The provided double value for '${name}' is non-finite.`)
  }
  return coordinate
}

/**
 * The `document` of one window of a GPUIX app: a DOM `Document` node that is also, with its window's
 * target, the top of the event path of that window's tree. It has its own `<html>`, `<head>` and
 * `<body>` (the elements its window's root made), `activeElement`, selection, `adoptedStyleSheets`
 * and node factories. The first window's is the global `document`.
 *
 * `Element` is what the adapter hands out for an element: React's host
 * instance, Solid's element.
 */
export class GpuixDocument<Element = unknown> extends Document {
  private readonly target: GpuixEventTarget
  private readonly binding: NodeBinding
  readonly #selection: Selection
  readonly #adopted = createAdoptedStyleSheets((sheets) => {
    const renderer = this.window.renderer
    if (renderer !== undefined) setAdoptedSheets(renderer, sheets)
  })

  /** @param onTypesChange Called when a type gains its first listener or loses its last. */
  constructor(
    readonly window: GpuixWindow,
    onTypesChange?: () => void
  ) {
    super()
    this.target = new GpuixEventTarget(onTypesChange, this)
    const document = this
    this.binding = {
      parent: null,
      get children(): readonly Node[] {
        return [document.documentElements().html as Node]
      },
      connected: true,
      root: null,
    }
    this.#selection = createSelection({
      document: this as unknown as Node,
      renderer: () => this.window.mountedRenderer,
      hooks: {
        listens: () => this.listensForSelectionChange(),
        dispatch: () => {
          this.dispatchEvent(new Event("selectionchange"))
        },
        heldChanged: notifyTypeSubscribers,
        focusHost: (host) => {
          const focused = this.liveEntry()?.focused
          if (focused !== undefined && focused !== null && host.contains(focused as Node)) return
          ;(host as unknown as FocusableElement).focus({ preventScroll: true })
        },
      },
    })
  }

  [DOM_BINDING](): NodeBinding {
    return this.binding
  }

  /** The window's root, or `undefined` while none is mounted and after the window closed. */
  private liveEntry(): ElementSourceEntry | undefined {
    const renderer = this.window.renderer
    const entry = renderer === undefined ? undefined : elementSources.get(renderer)
    return entry === undefined || entry.windowGone ? undefined : entry
  }

  /** @internal The `<html>`, `<head>` and `<body>` of the window's root, or the document's stand-ins while it has none. */
  documentElements(): DocumentElements {
    const mounted = this.liveEntry()?.source.documentElements() ?? null
    return mounted ?? installedStandIn().elements(this)
  }

  /** @internal The way this window's root makes nodes; throws while nothing is mounted. */
  private nodeFactory(method: string): DomNodeFactory {
    const entry = this.liveEntry()
    if (entry === undefined) {
      throw new Error(`document.${method} needs a mounted Ghia root. Call it after render().`)
    }
    const factory = entry.source.nodeFactory
    if (factory === null) {
      throw new Error(`The root of this window cannot make nodes, so document.${method} is unavailable`)
    }
    return factory
  }

  private executingCommand = false

  /**
   * Runs `copy`, `cut` or `selectAll` as the Edit menu does, and returns whether it did; `paste`
   * and every other command return false and do nothing (docs/fork/deviations.md). A call made while
   * another runs (from the `copy` event it fires) returns false and does nothing, as Chrome's does.
   */
  execCommand(commandId: string, _showUI?: boolean, _value?: string): boolean {
    if (this.executingCommand) return false
    this.executingCommand = true
    try {
      return documentCommands().exec(this, String(commandId))
    } finally {
      this.executingCommand = false
    }
  }

  queryCommandSupported(commandId: string): boolean {
    return documentCommands().supported(String(commandId))
  }

  queryCommandEnabled(commandId: string): boolean {
    return documentCommands().enabled(this, String(commandId))
  }

  /** The constructed sheets that apply to this document's window, in order; later ones win. */
  get adoptedStyleSheets(): CSSStyleSheet[] {
    return this.#adopted.array
  }

  set adoptedStyleSheets(sheets: Iterable<CSSStyleSheet>) {
    this.#adopted.replace(sheets)
  }

  /** @internal The window got a renderer (the global window moved to another): its native tree is told the sheets. */
  sendAdoptedSheets(renderer: NativeRenderer): void {
    setAdoptedSheets(renderer, this.#adopted.array)
  }

  addEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.target.addEventListener(type, listener, options)
  }

  removeEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | Pick<AddEventListenerOptions, "capture">
  ): void {
    this.target.removeEventListener(type, listener, options)
  }

  /** Whether any listener is registered for `type` in either phase. */
  hasListeners(type: string): boolean {
    return this.target.hasListeners(type)
  }

  /** @internal The types with a listener in either phase. */
  listenedTypes(): string[] {
    return this.target.listenedTypes()
  }

  /** @internal Calls the listeners of one phase: see `GpuixEventTarget.run`. */
  run(
    event: DomEvent,
    state: DomEventState,
    capture: boolean,
    phase: number,
    fail: (error: unknown) => void
  ): void {
    this.target.run(event, state, capture, phase, fail)
  }

  /** @internal Whether anything listens for `selectionchange` on this document or its window. */
  listensForSelectionChange(): boolean {
    return this.hasListeners("selectionchange") || this.window.events.hasListeners("selectionchange")
  }

  /**
   * Dispatches an event an app built (`new Event`, `new CustomEvent`, `new PointerEvent`) at
   * `document`: its window hears its capture phase, `document` its target phase, and the window its
   * bubble phase if it bubbles. Returns false when a listener called `preventDefault()` on a
   * cancelable event. Throws an `InvalidStateError` for an event already being dispatched.
   */
  dispatchEvent(event: Event): boolean {
    const state = beginDispatch(event, this)
    const errors: unknown[] = []
    walkAtTop(event as unknown as DomEvent, state, propagationHooks(this.window), (error) => errors.push(error), this)
    endDispatch(state)
    errors.forEach(reportUncaught)
    return !event.defaultPrevented
  }

  /**
   * A new element of this document's window, in no tree: insert it under a node in the
   * document and it is drawn. `tagName` is lowercased, as in an HTML document. A name that is
   * not one of the element types throws `NotSupportedError`, where a browser has an unknown
   * element.
   */
  createElement(tagName: string): HTMLElement {
    const name = String(tagName)
    assertElementName(name, "createElement")
    const type = name.toLowerCase()
    if (!isElementType(type)) throw unsupportedElement(type, "createElement")
    return this.made(this.nodeFactory("createElement").createElement(type)) as HTMLElement
  }

  /** `createElement` for the SVG namespace (names as written, `linearGradient`) or the HTML one. */
  createElementNS(namespace: string | null, qualifiedName: string): Element {
    const name = String(qualifiedName)
    assertElementName(name, "createElementNS")
    const wanted = namespace === SVG_NAMESPACE ? "svg" : namespace === HTML_NAMESPACE ? "html" : null
    if (wanted === null || !isElementType(name) || isSvgElementType(name) !== (wanted === "svg")) {
      throw unsupportedElement(name, "createElementNS")
    }
    return this.made(this.nodeFactory("createElementNS").createElement(name)) as Element
  }

  /** A new text node of this document's window, in no tree. */
  createTextNode(data: string): Text {
    return this.made(this.nodeFactory("createTextNode").createTextNode(String(data)))
  }

  /** A new empty `DocumentFragment` of this document's window. */
  createDocumentFragment(): DocumentFragment {
    return this.made(this.nodeFactory("createDocumentFragment").createDocumentFragment()) as DocumentFragment
  }

  private made<Made extends object>(node: Made): Made {
    adoptSubtree(node as unknown as Node, this)
    return node
  }

  /**
   * Takes `node` out of the tree it is in and makes this document its owner, as browsers do. A node
   * that a window mounted belongs to that window for good: it throws `HierarchyRequestError`, as moving it
   * into another window's tree does.
   */
  adoptNode<Adopted extends Node>(node: Adopted): Adopted {
    if (!(node instanceof Node)) {
      throw new TypeError("Failed to execute 'adoptNode' on 'Document': parameter 1 is not of type 'Node'.")
    }
    if (node.nodeType === NODE_TYPE_DOCUMENT) {
      throw new DOMException("Failed to execute 'adoptNode' on 'Document': Nodes of type '#document' may not be adopted.", "NotSupportedError")
    }
    const owner = ownerDocumentOf(node)
    if (owner !== (this as unknown as Document) && node[DOM_BINDING]().root !== null) throw crossRootError()
    node.parentNode?.removeChild(node)
    if (owner !== (this as unknown as Document)) adoptSubtree(node, this)
    return node
  }

  /** A copy of `node`, with its children when `deep`, that this document owns and no tree holds yet. */
  importNode<Imported extends Node>(node: Imported, deep = false): Imported {
    if (!(node instanceof Node)) {
      throw new TypeError("Failed to execute 'importNode' on 'Document': parameter 1 is not of type 'Node'.")
    }
    if (node.nodeType === NODE_TYPE_DOCUMENT) {
      throw new DOMException("Failed to execute 'importNode' on 'Document': The node provided is a document, which may not be imported.", "NotSupportedError")
    }
    const clone = node.cloneNode(Boolean(deep)) as Imported
    if (ownerDocumentOf(clone) !== (this as unknown as Document)) {
      if (clone[DOM_BINDING]().root !== null) throw crossRootError()
      adoptSubtree(clone, this)
    }
    return clone
  }

  /** A new `Range` collapsed at the start of this document: `(document, 0)`. */
  createRange(): Range {
    const range = new Range()
    range.setStart(this as unknown as Node, 0)
    range.collapse(true)
    return range
  }

  /**
   * Whether this document's window has focus. Native does not tell JS which window is the key one,
   * so it is the open window that heard a focus event last, and the first one open while none has.
   */
  hasFocus(): boolean {
    const own = this.liveEntry()
    if (own === undefined) return false
    let key: ElementSourceEntry | undefined
    for (const entry of elementSources.values()) {
      if (entry.windowGone) continue
      if (key === undefined || entry.focusedAt > key.focusedAt) key = entry
    }
    return key === own
  }

  /** A `TreeWalker` over `root`, standing on `root`, as `document.createTreeWalker` does: `whatToShow` is every node by default. */
  createTreeWalker(root: Node, whatToShow?: number, filter: NodeFilterLike | null = null): TreeWalker {
    return createTreeWalker(root, whatToShow, filter)
  }

  /** The `<html>` element of this document's window, or the document's stand-in `<html>` while none is mounted: never `null`. */
  get documentElement(): Element {
    return this.documentElements().html as Element
  }

  /** The `<head>` element of this document's window, before `body` in `documentElement`. */
  get head(): Element {
    return this.documentElements().head as Element
  }

  /** The `<body>` element of this document's window: where the app's top-level nodes are. */
  get body(): Element {
    return this.documentElements().body as Element
  }

  /** `"complete"`: a window has no page to load. */
  get readyState(): "complete" {
    return "complete"
  }

  /**
   * `"visible"` while a root is mounted in this document's window and the window is open, `"hidden"`
   * otherwise. Native does not report an occluded or minimized window, so a window that is open is visible.
   */
  get visibilityState(): "visible" | "hidden" {
    return this.window.isMounted ? "visible" : "hidden"
  }

  /** `visibilityState === "hidden"`. */
  get hidden(): boolean {
    return !this.window.isMounted
  }

  /** `"CSS1Compat"`: the document is laid out as a standards-mode page, which is what a library that tests for quirks mode expects. */
  get compatMode(): "CSS1Compat" {
    return "CSS1Compat"
  }

  /** The element that scrolls the document, which is `documentElement` as in standards mode. */
  get scrollingElement(): Element {
    return this.documentElement
  }

  /**
   * The elements under the point `(x, y)` of this document's window, in CSS pixels from its
   * top left corner, topmost first and ending with `body` then `html`: what `elementFromPoint`
   * answers with its first. Empty for a point outside the window. The window is laid out first,
   * so an element mounted in this turn is found, and `pointer-events: none`, `visibility: hidden`
   * and `display: none` elements are left out.
   */
  elementsFromPoint(x: number, y: number): Element[] {
    const renderer = this.window.requireRenderer("document.elementsFromPoint")
    if (renderer.getElementsAt === undefined) {
      throw new Error("This renderer cannot hit test, so document.elementsFromPoint is unavailable")
    }
    return renderer.getElementsAt(finiteCoordinate(x, "x"), finiteCoordinate(y, "y")).map((id) => {
      const element = elementOf(renderer, id)
      if (element === undefined) {
        throw new Error(`Element ${id} is under the point but its root has no element for it`)
      }
      return element as Element
    })
  }

  /** The topmost of `elementsFromPoint`, or `null` for a point outside the window. */
  elementFromPoint(x: number, y: number): Element | null {
    return this.elementsFromPoint(x, y)[0] ?? null
  }

  /**
   * The place in a Text node at the point `(x, y)` of this document's window, in CSS pixels from
   * its top left corner: the text under the point, or the nearest painted text, and the offset of the
   * character boundary nearest to it. `null` when no text is painted. A point over no text still
   * answers, with the nearest one (deviations.md).
   */
  caretPositionFromPoint(x: number, y: number, _options?: unknown): CaretPosition | null {
    const found = caretFromPoint(this.window.requireRenderer("document.caretPositionFromPoint"), finiteCoordinate(x, "x"), finiteCoordinate(y, "y"))
    return found === null ? null : createCaretPosition(found.node, found.offset)
  }

  /** `caretPositionFromPoint` as a collapsed `Range`. */
  caretRangeFromPoint(x: number, y: number): Range | null {
    const found = caretFromPoint(this.window.requireRenderer("document.caretRangeFromPoint"), finiteCoordinate(x, "x"), finiteCoordinate(y, "y"))
    if (found === null) return null
    const range = new Range()
    range.setStart(found.node, found.offset)
    range.collapse(true)
    return range
  }

  /** The text selection of this document's window. */
  getSelection(): Selection {
    return this.#selection
  }

  /**
   * The window the document is in: the global object, which `dom-globals` installs as `window`, for the first
   * window (where a library that takes `element.ownerDocument.defaultView` as its window finds
   * `setTimeout`, `requestAnimationFrame` and `ResizeObserver`), and the window's own target for another.
   */
  get defaultView(): typeof globalThis {
    return (this.window === globalWindow() ? globalThis : this.window) as typeof globalThis
  }

  /**
   * The focused element of this document's window, the same object a `ref` gives, or `body` when
   * nothing is focused, as in a browser (floating-ui's focus management compares the active
   * element with `document.body` to tell "focus was lost" from "focus went elsewhere").
   */
  get activeElement(): Element {
    const entry = this.liveEntry()
    const id = entry?.source.focusedId() ?? null
    if (entry === undefined || id === null) return this.body
    const element = entry.source.elementById(id)
    if (element === undefined) {
      throw new Error(`Element ${id} holds focus but its root has no element for it`)
    }
    return element as Element
  }

  /**
   * The element of this document's window that holds the pointer lock, the same object a `ref`
   * gives, or `null` while none does. Where the platform can lock (macOS) it is held as
   * soon as `requestPointerLock()` returns, before `pointerlockchange` arrives.
   */
  get pointerLockElement(): Element | null {
    const entry = this.liveEntry()
    const id = entry?.source.pointerLockId() ?? null
    if (entry === undefined || id === null) return null
    const element = entry.source.elementById(id)
    if (element === undefined) {
      throw new Error(`Element ${id} holds the pointer lock but its root has no element for it`)
    }
    return element as Element
  }

  /**
   * The CSS transitions, then the CSS animations, of this document's window, as `Animation` objects:
   * those of its elements in document order (every transition, then every animation). The same
   * objects `element.getAnimations()` gives.
   */
  getAnimations(): Animation[] {
    const list = Reflect.get(globalThis, DOCUMENT_ANIMATIONS_KEY) as ((renderer: object) => Animation[]) | undefined
    if (!list) throw new Error("Web Animations are not loaded: import @ghia/native/host before document.getAnimations()")
    const renderer = this.window.renderer
    return renderer === undefined || this.liveEntry() === undefined ? [] : list(renderer)
  }
}

const NODE_TYPE_DOCUMENT = 9

/** @internal Called by `web-animations` once, with how to list the animations of one renderer's window. */
export function setDocumentAnimations(list: (renderer: object) => Animation[]): void {
  Reflect.set(globalThis, DOCUMENT_ANIMATIONS_KEY, list)
}

function createWindow(isGlobal: boolean): GpuixWindow {
  // Its listeners see the global object, which `dom-globals` installs as `window`, as `currentTarget`.
  const made: GpuixWindow = new GpuixWindow({
    onTypesChange: notifyTypeSubscribers,
    owner: isGlobal ? globalThis : undefined,
    mounted: () => {
      const renderer = made.renderer
      if (renderer === undefined) return false
      const entry = elementSources.get(renderer)
      return entry === undefined ? made.attached && !made.closed : !entry.windowGone
    },
  })
  made.bindDocument(new GpuixDocument(made, notifyTypeSubscribers))
  return made
}

type WindowRegistry = {
  /** The window of each renderer. */
  records: WeakMap<object, GpuixWindow>
  /**
   * The global window and `document`: the first window's, for as long as it lives. They are made before
   * any window exists and work as a stand-in until one mounts, and a window that mounts while no
   * other holds them (none was before, or the one that did was disposed or unmounted and has no
   * window open) takes them over. A window that mounts while another holds them gets its own.
   */
  global: GpuixWindow
}

/** Kept on `globalThis` like the element sources: a second evaluation of this module (`bun --hot`, two copies of the package) shares the windows. */
const REGISTRY_KEY = Symbol.for("@ghia/native/window-registry")

const registry: WindowRegistry = (() => {
  const existing = Reflect.get(globalThis, REGISTRY_KEY) as WindowRegistry | undefined
  if (existing) return existing
  const created: WindowRegistry = { records: new WeakMap(), global: createWindow(true) }
  Reflect.set(globalThis, REGISTRY_KEY, created)
  return created
})()

const records = registry.records
const globalRecord = registry.global

export const window = globalRecord.events
export const document = globalRecord.document

/** The global window: what `globalThis.window` is, and the first window's target. */
export function globalWindow(): GpuixWindow {
  return globalRecord
}

/** Whether a renderer can still become the global window's: no root holds it, and its window did not close. */
function globalAvailable(): boolean {
  const holder = globalRecord.renderer
  return holder === undefined || (!globalRecord.closed && !globalRecord.attached && !elementSources.has(holder))
}

function takeGlobal(renderer: NativeRenderer): GpuixWindow {
  const previous = globalRecord.renderer
  if (previous !== undefined) records.delete(previous)
  globalRecord.renderer = renderer
  globalRecord.closed = false
  records.set(renderer, globalRecord)
  globalRecord.document.sendAdoptedSheets(renderer)
  globalRecord.syncResize()
  return globalRecord
}

/**
 * @internal The window of `renderer`: its `document`, its event target at the top of the event path
 * and the members of `window` that are its own. The first renderer asked for takes the global window;
 * every other gets a window of its own, which it keeps for its life.
 */
export function windowOf(renderer: NativeRenderer): GpuixWindow {
  const known = records.get(renderer)
  if (known !== undefined) return known
  if (globalAvailable()) return takeGlobal(renderer)
  const made = createWindow(false)
  made.renderer = renderer
  records.set(renderer, made)
  made.document.sendAdoptedSheets(renderer)
  return made
}

/** @internal The document of `renderer`'s window. */
export function documentOf(renderer: NativeRenderer): GpuixDocument {
  return windowOf(renderer).document
}

/** The document a node belongs to: its window's once mounted, else the document that made or adopted it, else the global `document`. */
function ownerDocumentOfNode(node: Node): Document {
  const root = node[DOM_BINDING]().root
  if (root !== null) return documentOf(root.nativeRenderer as NativeRenderer) as unknown as Document
  return makerDocumentOf(node) ?? (document as unknown as Document)
}

registerDocument(document as unknown as Document, ownerDocumentOfNode)

/** Calls `listener` whenever a type gains its first listener or loses its last on a `window` or `document`. */
export function subscribeWindowEventTypes(listener: () => void): () => void {
  typeSubscribers.add(listener)
  return () => {
    typeSubscribers.delete(listener)
  }
}

/**
 * Lets the runtime see the elements of the root that drives `renderer`, through
 * `elementById`: the object the adapter gives for an element id, as a `ref`
 * does. `document.activeElement` and the `target`, `currentTarget` and
 * `relatedTarget` of every event read it, and `document.documentElement`,
 * `document.head` and `document.body` read `documentElements`. `nodeFactory` is what
 * `document.createElement` and `document.createTextNode` build nodes with. The returned function takes the root
 * out again. A renderer that cannot report focus still names its elements; it
 * just never has an `activeElement`.
 */
export function installElementSource(
  renderer: { getFocusedElementId?: () => number | null; pointerLockElement?: () => number | null },
  elementById: (id: number) => object | undefined,
  documentElements?: () => DocumentElements,
  nodeFactory?: DomNodeFactory
): () => void {
  const getFocusedElementId = renderer.getFocusedElementId
  const getPointerLockElement = renderer.pointerLockElement
  const entry: ElementSourceEntry = {
    source: {
      focusedId: () => (getFocusedElementId ? getFocusedElementId.call(renderer) : null),
      pointerLockId: () => (getPointerLockElement ? getPointerLockElement.call(renderer) : null),
      elementById,
      documentElements: () => (documentElements ? documentElements() : null),
      nodeFactory: nodeFactory ?? null,
    },
    windowGone: false,
    focusedAt: 0,
    focused: null,
  }
  const owner = windowOf(renderer as NativeRenderer)
  elementSources.set(renderer, entry)
  bumpTreeVersion()
  const mounted = entry.source.documentElements()
  // Not installed: nothing could have read a stand-in, which throws.
  if (mounted !== null) standInDocument?.replace(owner.document, mounted)
  owner.syncResize()
  return () => {
    if (elementSources.get(renderer) === entry) {
      elementSources.delete(renderer)
      bumpTreeVersion()
      owner.syncResize()
    }
  }
}

/**
 * Releases `renderer` for good, as a test window's `dispose()` does: nothing asks its root for
 * elements, and if it held the global window, even a closed one, the next window to mount takes it.
 */
export function forgetElementSource(renderer: object): void {
  elementSources.delete(renderer)
  bumpTreeVersion()
  const owner = records.get(renderer)
  if (owner === undefined) return
  owner.attached = false
  if (owner === globalRecord) owner.closed = false
  owner.syncResize()
}

/**
 * Stops asking `renderer` what is focused or animating, for a renderer whose
 * window another took over or that was closed: its root still names its
 * elements, but the window it would ask about is not its own any more. Its document
 * has no roots from then on, and if it is the global one it stays the global one.
 */
export function forgetWindowSource(renderer: object): void {
  const entry = elementSources.get(renderer)
  if (entry) entry.windowGone = true
  const owner = records.get(renderer)
  if (owner === undefined) return
  owner.closed = true
  owner.syncResize()
}

/**
 * @internal The element `renderer`'s root has for `id`, or `undefined` once it
 * dropped it. Throws when no adapter installed a source for `renderer`: the
 * ids of its events cannot be turned into elements.
 */
export function elementOf(renderer: object, id: number): object | undefined {
  const entry = elementSources.get(renderer)
  if (!entry) {
    throw new Error(
      "No element source is installed for this renderer: an adapter's root installs one with installElementSource before events arrive."
    )
  }
  return entry.source.elementById(id)
}

setElementLookup(elementOf)

/** @internal Records that `owner`'s window just moved focus, for the tie-break of `activeElement`. */
export function noteFocusEvent(owner: object): void {
  const entry = elementSources.get(owner)
  if (entry) entry.focusedAt = ++focusClock
}

/**
 * @internal Follows the focus events native reports, so a question of "is focus inside this element" (the selection
 * entering an editing host asks it on every change) is a read of JS state and no native query.
 */
export function trackFocusedElement(owner: object, eventType: "focusin" | "focusout", element: object | undefined): void {
  const entry = elementSources.get(owner)
  if (entry === undefined) return
  if (eventType === "focusin") entry.focused = element ?? null
  else if (entry.focused === element) entry.focused = null
}

/**
 * Keeps `renderer` told which event types its window or its document listens for,
 * so native produces them even when no element on the event's path does (the
 * pointer over bare background). Sends the current set now and again whenever
 * it changes. The returned function clears it on the renderer and stops.
 */
export function syncWindowEventListeners(renderer: NativeRenderer): () => void {
  const owner = windowOf(renderer)
  const send = () => {
    renderer.setWindowEventListeners?.([
      ...new Set([...owner.events.listenedTypes(), ...owner.document.listenedTypes()]),
    ])
  }
  send()
  typeSubscribers.add(send)
  return () => {
    typeSubscribers.delete(send)
    renderer.setWindowEventListeners?.([])
  }
}

/**
 * Whether native's `selectionChange` is wanted in `owner`: for a listener, and while a node selection
 * is held, which painted text that the user selects replaces.
 */
export function wantsNativeSelectionChange(owner: GpuixWindow): boolean {
  return owner.document.listensForSelectionChange() || holdsNodeSelection(owner.document.getSelection())
}

/**
 * Keeps the renderer's `selectionChange` event on while `rootListens()` says the root wants it or a
 * `selectionchange` listener exists on its `window` or `document`, or a node selection is held. `resync` after `rootListens` may
 * have changed; `stop` turns it off. Native names the window's event with `eventId`.
 */
export function syncWindowSelectionChange(
  renderer: NativeRenderer,
  eventId: number,
  rootListens: () => boolean
): { resync: () => void; stop: () => void } {
  const owner = windowOf(renderer)
  const resync = () => {
    renderer.setWindowSelectionChange?.(rootListens() || wantsNativeSelectionChange(owner), eventId)
  }
  resync()
  typeSubscribers.add(resync)
  return {
    resync,
    stop() {
      typeSubscribers.delete(resync)
      renderer.setWindowSelectionChange?.(false, eventId)
    },
  }
}

/**
 * Sends `selectionchange` to `owner`'s `document`, as the DOM does: it does not bubble, so its window hears
 * it in the capture phase only. `payload.value` is the selected text, absent after a clear.
 */
export function dispatchSelectionChange(root: DomEventRoot, payload: EventPayload, owner: GpuixWindow): void {
  dispatchPropagating(root, { ...payload, eventType: "selectionchange", elementId: 0 }, owner)
}

const DOCUMENT_EVENT_TYPES: ReadonlySet<string> = new Set(["pointerlockchange", "pointerlockerror", "selectionchange"])

/** Whether the DOM aims the event at `document` itself, with no element on the path. */
export function isDocumentEvent(eventType: string): boolean {
  return DOCUMENT_EVENT_TYPES.has(eventType)
}

export interface PropagationResult extends DomDispatchResult {
  /** The event the listeners saw. */
  event: DomEvent
}

/**
 * Runs an event through the whole propagation: its window's capture, its document's
 * capture, the element path, document bubble, window bubble. An event with no
 * element path is aimed at the window and only those two targets hear it. `top` is the
 * window the event happened in: another window's `window` and `document` never hear it.
 *
 * `scoped` is a window-level target that belongs to one renderer, such as the
 * `onKeyDown` option of its root. It hears the bubble phase after `window`.
 */
export function dispatchPropagating(
  root: DomEventRoot,
  payload: EventPayload,
  top: GpuixWindow,
  scoped?: GpuixEventTarget
): PropagationResult {
  const hooks = propagationHooks(top, scoped)
  if (payload.path && payload.path.length > 0) {
    let seen: DomEvent | undefined
    const result = dispatchDomEvent(root, payload, {
      beforeCapture(event, state, fail) {
        seen = event
        hooks.beforeCapture(event, state, fail)
      },
      afterBubble: hooks.afterBubble,
    })
    if (!seen) throw new Error(`Event "${payload.eventType}" was dispatched without an event object.`)
    return { ...result, event: seen }
  }

  const { event, state } = createDomEvent(
    root,
    payload,
    [],
    isDocumentEvent(payload.eventType) ? top.document : null
  )
  const errors: unknown[] = []
  walkAtTop(event, state, hooks, (error) => errors.push(error), top.document)
  reportHandlerErrors(root, errors)
  return {
    defaultPrevented: event.defaultPrevented,
    propagationStopped: state.propagationStopped,
    event,
  }
}

/** The phases of a window and its document around an element path: both listen in capture, the document then the window bubble. */
function propagationHooks(top: GpuixWindow, scoped?: GpuixEventTarget): Required<DomDispatchHooks> {
  const document = top.document
  // When `document` is the target, both its capture and bubble listeners run at the target.
  const documentPhase = (event: DomEvent, phase: number) =>
    event.target === document ? EVENT_PHASE_AT_TARGET : phase
  return {
    beforeCapture(event, state, fail) {
      top.events.run(event, state, true, EVENT_PHASE_CAPTURING, fail)
      if (!state.propagationStopped) {
        document.run(event, state, true, documentPhase(event, EVENT_PHASE_CAPTURING), fail)
      }
    },
    afterBubble(event, state, fail) {
      document.run(event, state, false, documentPhase(event, EVENT_PHASE_BUBBLING), fail)
      if (!state.propagationStopped) top.events.run(event, state, false, EVENT_PHASE_BUBBLING, fail)
      if (!state.propagationStopped) scoped?.run(event, state, false, EVENT_PHASE_BUBBLING, fail)
    },
  }
}

/** An event with no element path: aimed at the window or at `document`, which only they hear. */
function walkAtTop(
  event: DomEvent,
  state: DispatchState,
  hooks: Required<DomDispatchHooks>,
  fail: (error: unknown) => void,
  document: GpuixDocument
): void {
  state.dispatching = true
  hooks.beforeCapture(event, state, fail)
  if (!state.propagationStopped) {
    if (event.bubbles) hooks.afterBubble(event, state, fail)
    // A non-bubbling event still reaches the bubble listeners of its own target.
    else if (event.target === document) document.run(event, state, false, EVENT_PHASE_AT_TARGET, fail)
  }
  event.currentTarget = null
  event.eventPhase = EVENT_PHASE_NONE
  state.dispatching = false
}

/**
 * `dispatchEvent` of a connected element: the event an app built walks the element's ancestors
 * (`path`, target first), with the `window` and `document` of its window around them, as one Ghia
 * delivers does. Listeners of a element that is not connected hear it alone. A listener that
 * throws goes to `report`, after the walk.
 */
export function dispatchEventAlongPath(
  event: Event,
  path: readonly object[],
  handlersAt: HandlersAt,
  connected: boolean,
  report: (error: unknown) => void,
  top: GpuixWindow
): void {
  const state = beginDispatch(event, path[0] ?? top.document)
  state.path = path
  const errors: unknown[] = []
  walkDomEvent(
    event as unknown as DomEvent,
    state,
    path,
    handlersAt,
    connected ? propagationHooks(top) : undefined,
    (error) => errors.push(error)
  )
  endDispatch(state)
  errors.forEach(report)
}

/** What the DOM clears when a dispatch ends: the stop flags and the path. The event keeps its target and its canceled flag. */
function endDispatch(state: DispatchState): void {
  state.propagationStopped = false
  state.immediatePropagationStopped = false
  state.path = []
}

/**
 * What `dispatchEvent` checks before it does anything: `event` is an `Event` and is not being
 * dispatched. A caller that acts before the dispatch (a click's pre-activation) runs this first, so
 * a rejected event leaves nothing to undo.
 */
export function assertDispatchable(event: Event): DispatchState {
  if (!(event instanceof Event)) {
    throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.")
  }
  const state = dispatchStateOf(event)
  if (state.dispatching) {
    throw new DOMException(
      "Failed to execute 'dispatchEvent' on 'EventTarget': The event is already being dispatched.",
      "InvalidStateError"
    )
  }
  return state
}

/** The state of a dispatch of an app's `event` at `target`, which it must not already be in. */
function beginDispatch(event: Event, target: object): DispatchState {
  const state = assertDispatchable(event)
  ;(event as unknown as DomEvent & { target: object }).target = target
  return state
}
