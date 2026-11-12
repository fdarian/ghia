import type { EventPayload } from "../../index.js"
import type { Animation } from "../web-animations.js"
import { isElementType, isSvgElementType } from "../dom/element-types.js"
import { Document, DOM_BINDING, registerDocument, type HTMLElement, type Node, type NodeBinding, type Text } from "../dom/nodes.js"
import { getAdoptedStyleSheets, replaceAdoptedStyleSheets, type CSSStyleSheet } from "../css/index.js"
import { getSelection, type Selection } from "../dom/selection.js"
import { mountedRenderer } from "../mounted-renderer.js"
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

export type WindowEventListener = (event: DomEvent) => void

export interface AddEventListenerOptions {
  /** Listen in the capture phase, before the element tree sees the event. */
  capture?: boolean
  /** Remove the listener after its first call. */
  once?: boolean
}

interface Registration {
  listener: WindowEventListener
  capture: boolean
  once: boolean
}

/**
 * The `window` and `document` of a GPUIX app: an `EventTarget` shaped like the
 * DOM's, for events that reach the top of the tree.
 *
 * Event types are the DOM's lowercase names (`keydown`, `keyup`, `focusin`,
 * `focusout`, `focus`, `blur`). `focus` and `blur` do not bubble, so only a
 * capture listener hears them, as in the DOM.
 */
export class GpuixEventTarget {
  private readonly registrations = new Map<string, Registration[]>()

  /**
   * @param onTypesChange Called when a type gains its first listener or loses its last.
   * @param owner What `event.currentTarget` is while this target runs its listeners, when it
   * stands in for another object (a `document` that holds its target by composition).
   */
  constructor(
    private readonly onTypesChange?: () => void,
    private readonly owner?: object
  ) {}

  addEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | AddEventListenerOptions
  ): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true
    const once = typeof options === "object" && options.once === true
    const key = type.toLowerCase()
    const registrations = this.registrations.get(key) ?? []
    if (registrations.some((entry) => entry.listener === listener && entry.capture === capture)) {
      return
    }
    registrations.push({ listener, capture, once })
    this.registrations.set(key, registrations)
    if (registrations.length === 1) this.onTypesChange?.()
  }

  removeEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | Pick<AddEventListenerOptions, "capture">
  ): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true
    const key = type.toLowerCase()
    const registrations = this.registrations.get(key)
    if (!registrations) return
    const index = registrations.findIndex(
      (entry) => entry.listener === listener && entry.capture === capture
    )
    if (index < 0) return
    registrations.splice(index, 1)
    if (registrations.length === 0) {
      this.registrations.delete(key)
      this.onTypesChange?.()
    }
  }

  /** Whether any listener is registered for `type` in either phase. */
  hasListeners(type: string): boolean {
    return this.registrations.has(type.toLowerCase())
  }

  /** @internal The types with a listener in either phase. */
  listenedTypes(): string[] {
    return [...this.registrations.keys()]
  }

  /**
   * @internal Calls the listeners of one phase. A listener that throws does not
   * end the phase: its error goes to `fail`.
   */
  run(
    event: DomEvent,
    state: DomEventState,
    capture: boolean,
    phase: number,
    fail: (error: unknown) => void
  ): void {
    const registrations = this.registrations.get(event.type.toLowerCase())
    if (!registrations) return
    event.currentTarget = this.owner ?? this
    event.eventPhase = phase
    // A listener may add or remove listeners; this call sees the ones that
    // were there when the phase started.
    for (const entry of [...registrations]) {
      if (state.immediatePropagationStopped) return
      if (entry.capture !== capture) continue
      if (entry.once) this.removeEventListener(event.type, entry.listener, entry.capture)
      try {
        entry.listener(event)
      } catch (error) {
        fail(error)
      }
    }
  }
}

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

/**
 * The document is the top of every mounted tree. It lists the `<html>` of each window, the
 * most recent of which is `document.documentElement`: one document spans every window. With no
 * window it lists the stand-in `<html>` (`dom/stand-in-document.ts`), as a browser's document always has one.
 */
const DOCUMENT_BINDING: NodeBinding = {
  parent: null,
  get children(): readonly Node[] {
    const windows = [...elementSources.values()].flatMap((entry) => {
      const elements = entry.source.documentElements()
      return elements === null ? [] : [elements.html as Node]
    })
    return windows.length > 0 ? windows : [standInDocumentElements().html as Node]
  },
  connected: true,
  root: null,
}

let standInProvider: (() => DocumentElements) | undefined

/**
 * Registers the `<html>`, `<head>` and `<body>` `document` answers with while no root is mounted.
 * They are built from the element classes, which load this module, so `dom-globals.ts` hands them
 * over instead of this module importing them.
 */
export function installStandInDocument(provider: () => DocumentElements): void {
  standInProvider = provider
}

function standInDocumentElements(): DocumentElements {
  if (standInProvider === undefined) {
    throw new Error("The stand-in document is not installed: import @ghia/native/host before reading document.documentElement")
  }
  return standInProvider()
}

/** The way the window `document` stands for makes nodes; throws while nothing is mounted. */
function currentNodeFactory(method: string): DomNodeFactory {
  const renderer = mountedRenderer()
  if (renderer === undefined) {
    throw new Error(`document.${method} needs a mounted Ghia root. Call it after render().`)
  }
  const factory = elementSources.get(renderer)?.source.nodeFactory
  if (factory === undefined || factory === null) {
    throw new Error(`The root of this window cannot make nodes, so document.${method} is unavailable`)
  }
  return factory
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

/** The elements of the window `document` stands for: the most recently mounted root's, or the stand-in's while none is mounted. */
function currentDocumentElements(): DocumentElements {
  const renderer = mountedRenderer()
  const mounted = renderer === undefined ? null : elementSources.get(renderer)?.source.documentElements() ?? null
  return mounted ?? standInDocumentElements()
}

function finiteCoordinate(value: number, name: string): number {
  const coordinate = Number(value)
  if (!Number.isFinite(coordinate)) {
    throw new TypeError(`Failed to execute 'elementsFromPoint' on 'Document': The provided double value for '${name}' is non-finite.`)
  }
  return coordinate
}

/**
 * The `document` of a GPUIX app: a DOM `Document` node that is also the `window` target,
 * plus `activeElement` and `pointerLockElement`.
 *
 * `Element` is what the adapter hands out for an element: React's host
 * instance, Solid's element.
 */
export class GpuixDocument<Element = unknown> extends Document {
  private readonly target: GpuixEventTarget

  /** @param onTypesChange Called when a type gains its first listener or loses its last. */
  constructor(onTypesChange?: () => void) {
    super()
    this.target = new GpuixEventTarget(onTypesChange, this)
  }

  [DOM_BINDING](): NodeBinding {
    return DOCUMENT_BINDING
  }

  /** The constructed sheets that apply to every window of the app, in order; later ones win. */
  get adoptedStyleSheets(): CSSStyleSheet[] {
    return getAdoptedStyleSheets()
  }

  set adoptedStyleSheets(sheets: Iterable<CSSStyleSheet>) {
    replaceAdoptedStyleSheets(sheets)
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

  /**
   * Dispatches an event an app built (`new Event`, `new CustomEvent`, `new PointerEvent`) at
   * `document`: `window` hears its capture phase, `document` its target phase, and `window` its
   * bubble phase if it bubbles. Returns false when a listener called `preventDefault()` on a
   * cancelable event. Throws an `InvalidStateError` for an event already being dispatched.
   */
  dispatchEvent(event: Event): boolean {
    const state = beginDispatch(event, this)
    const errors: unknown[] = []
    walkAtTop(event as unknown as DomEvent, state, propagationHooks(), (error) => errors.push(error))
    endDispatch(state)
    errors.forEach(reportUncaught)
    return !event.defaultPrevented
  }

  /**
   * A new element of the window that mounted last, in no tree: insert it under a node in the
   * document and it is drawn. `tagName` is lowercased, as in an HTML document. A name that is
   * not one of the element types throws `NotSupportedError`, where a browser has an unknown
   * element.
   */
  createElement(tagName: string): HTMLElement {
    const name = String(tagName)
    assertElementName(name, "createElement")
    const type = name.toLowerCase()
    if (!isElementType(type)) throw unsupportedElement(type, "createElement")
    return currentNodeFactory("createElement").createElement(type) as HTMLElement
  }

  /** `createElement` for the SVG namespace (names as written, `linearGradient`) or the HTML one. */
  createElementNS(namespace: string | null, qualifiedName: string): Element {
    const name = String(qualifiedName)
    assertElementName(name, "createElementNS")
    const wanted = namespace === SVG_NAMESPACE ? "svg" : namespace === HTML_NAMESPACE ? "html" : null
    if (wanted === null || !isElementType(name) || isSvgElementType(name) !== (wanted === "svg")) {
      throw unsupportedElement(name, "createElementNS")
    }
    return currentNodeFactory("createElementNS").createElement(name) as Element
  }

  /** A new text node of the window that mounted last, in no tree. */
  createTextNode(data: string): Text {
    return currentNodeFactory("createTextNode").createTextNode(String(data))
  }

  /** The `<html>` element of the window that mounted last, or the stand-in `<html>` while nothing is mounted: never `null`. */
  get documentElement(): Element {
    return currentDocumentElements().html as Element
  }

  /** The `<head>` element of the window that mounted last, before `body` in `documentElement`. */
  get head(): Element {
    return currentDocumentElements().head as Element
  }

  /** The `<body>` element of the window that mounted last: where the app's top-level nodes are. */
  get body(): Element {
    return currentDocumentElements().body as Element
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
   * The elements under the point `(x, y)` of the window that mounted last, in CSS pixels from its
   * top left corner, topmost first and ending with `body` then `html`: what `elementFromPoint`
   * answers with its first. Empty for a point outside the window. The window is laid out first,
   * so an element mounted in this turn is found, and `pointer-events: none`, `visibility: hidden`
   * and `display: none` elements are left out.
   */
  elementsFromPoint(x: number, y: number): Element[] {
    const renderer = mountedRenderer()
    if (renderer === undefined) {
      throw new Error("document.elementsFromPoint needs a mounted GPUIX root. Call it after render().")
    }
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

  /** The text selection of the window that mounted last. */
  getSelection(): Selection {
    return getSelection()
  }

  /**
   * The global object, which `dom-globals` installs as `window`: where a library that takes
   * `element.ownerDocument.defaultView` as its window finds `setTimeout`, `requestAnimationFrame`
   * and `ResizeObserver`. There is one window object for every window of the app.
   */
  get defaultView(): typeof globalThis {
    return globalThis
  }

  /**
   * The focused element, the same object a `ref` gives, or `body` when nothing
   * is focused, as in a browser (floating-ui's focus management compares the active
   * element with `document.body` to tell "focus was lost" from "focus went elsewhere").
   * With several windows (one root each), the window that holds focus decides: of the
   * roots that have a focused element, the one that heard a focus event last.
   */
  get activeElement(): Element {
    let chosen: { entry: ElementSourceEntry; id: number } | undefined
    for (const entry of elementSources.values()) {
      if (entry.windowGone) continue
      const id = entry.source.focusedId()
      if (id === null) continue
      if (!chosen || entry.focusedAt > chosen.entry.focusedAt) chosen = { entry, id }
    }
    if (!chosen) return this.body
    const element = chosen.entry.source.elementById(chosen.id)
    if (element === undefined) {
      throw new Error(`Element ${chosen.id} holds focus but its root has no element for it`)
    }
    return element as Element
  }

  /**
   * The element that holds the pointer lock, the same object a `ref` gives, or
   * `null` while none does. Where the platform can lock (macOS) it is held as
   * soon as `requestPointerLock()` returns, before `pointerlockchange` arrives.
   */
  get pointerLockElement(): Element | null {
    for (const entry of elementSources.values()) {
      if (entry.windowGone) continue
      const id = entry.source.pointerLockId()
      if (id === null) continue
      const element = entry.source.elementById(id)
      if (element === undefined) {
        throw new Error(`Element ${id} holds the pointer lock but its root has no element for it`)
      }
      return element as Element
    }
    return null
  }

  /**
   * The CSS transitions, then the CSS animations, of every window, as `Animation` objects: for
   * each renderer in the order its root was installed, those of its elements in document order
   * (every transition, then every animation). The same objects `element.getAnimations()` gives.
   */
  getAnimations(): Animation[] {
    const list = Reflect.get(globalThis, DOCUMENT_ANIMATIONS_KEY) as ((renderer: object) => Animation[]) | undefined
    if (!list) throw new Error("Web Animations are not loaded: import @ghia/native/host before document.getAnimations()")
    return [...elementSources].flatMap(([renderer, entry]) => (entry.windowGone ? [] : list(renderer)))
  }
}

/**
 * Kept on `globalThis` like the element sources: the module that makes `Animation` objects
 * (`web-animations`) imports this one, so it hands `document` the way to list a renderer's.
 */
const DOCUMENT_ANIMATIONS_KEY = Symbol.for("@ghia/native/document-animations")

/** @internal Called by `web-animations` once, with how to list the animations of one renderer's window. */
export function setDocumentAnimations(list: (renderer: object) => Animation[]): void {
  Reflect.set(globalThis, DOCUMENT_ANIMATIONS_KEY, list)
}

/** Calls `listener` whenever a type gains its first listener or loses its last on `window` or `document`. */
export function subscribeWindowEventTypes(listener: () => void): () => void {
  typeSubscribers.add(listener)
  return () => {
    typeSubscribers.delete(listener)
  }
}

/** Its listeners see the global object, which `dom-globals` installs as `window`, as `currentTarget`. */
export const window = new GpuixEventTarget(notifyTypeSubscribers, globalThis)
export const document = new GpuixDocument(notifyTypeSubscribers)
registerDocument(document)

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
  }
  elementSources.set(renderer, entry)
  return () => {
    if (elementSources.get(renderer) === entry) elementSources.delete(renderer)
  }
}

/** Drops the root of `renderer` whose window is gone, so nothing asks it for elements. */
export function forgetElementSource(renderer: object): void {
  elementSources.delete(renderer)
}

/**
 * Stops asking `renderer` what is focused or animating, for a renderer whose
 * window another took over or that was closed: its root still names its
 * elements, but the window it would ask about is not its own any more.
 */
export function forgetWindowSource(renderer: object): void {
  const entry = elementSources.get(renderer)
  if (entry) entry.windowGone = true
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

/** @internal Records that `owner`'s window just moved focus, for the tie-break of `activeElement`. */
export function noteFocusEvent(owner: object): void {
  const entry = elementSources.get(owner)
  if (entry) entry.focusedAt = ++focusClock
}

/**
 * Keeps `renderer` told which event types `window` or `document` listens for,
 * so native produces them even when no element on the event's path does (the
 * pointer over bare background). Sends the current set now and again whenever
 * it changes. The returned function clears it on the renderer and stops.
 */
export function syncWindowEventListeners(renderer: {
  setWindowEventListeners?: (types: string[]) => void
}): () => void {
  const send = () => {
    renderer.setWindowEventListeners?.([
      ...new Set([...window.listenedTypes(), ...document.listenedTypes()]),
    ])
  }
  send()
  typeSubscribers.add(send)
  return () => {
    typeSubscribers.delete(send)
    renderer.setWindowEventListeners?.([])
  }
}

/** Whether anything listens for `selectionchange`, which native only produces while it is asked to. */
export function listensForSelectionChange(): boolean {
  return document.hasListeners("selectionchange") || window.hasListeners("selectionchange")
}

/**
 * Keeps the renderer's `selectionChange` event on while `rootListens()` says the root wants it or a
 * `selectionchange` listener exists on `window` or `document`. `resync` after `rootListens` may
 * have changed; `stop` turns it off. Native names the window's event with `eventId`.
 */
export function syncWindowSelectionChange(
  renderer: { setWindowSelectionChange?: (enabled: boolean, eventId: number) => void },
  eventId: number,
  rootListens: () => boolean
): { resync: () => void; stop: () => void } {
  const resync = () => {
    renderer.setWindowSelectionChange?.(rootListens() || listensForSelectionChange(), eventId)
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
 * Sends `selectionchange` to `document`, as the DOM does: it does not bubble, so `window` hears
 * it in the capture phase only. `payload.value` is the selected text, absent after a clear.
 */
export function dispatchSelectionChange(root: DomEventRoot, payload: EventPayload): void {
  dispatchPropagating(root, { ...payload, eventType: "selectionchange", elementId: 0 })
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
 * Runs an event through the whole propagation: window capture, document
 * capture, the element path, document bubble, window bubble. An event with no
 * element path is aimed at the window and only those two targets hear it.
 *
 * `scoped` is a window-level target that belongs to one renderer, such as the
 * `onKeyDown` option of its root. It hears the bubble phase after `window`.
 */
export function dispatchPropagating(
  root: DomEventRoot,
  payload: EventPayload,
  scoped?: GpuixEventTarget
): PropagationResult {
  const hooks = propagationHooks(scoped)
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
    isDocumentEvent(payload.eventType) ? document : null
  )
  const errors: unknown[] = []
  walkAtTop(event, state, hooks, (error) => errors.push(error))
  reportHandlerErrors(root, errors)
  return {
    defaultPrevented: event.defaultPrevented,
    propagationStopped: state.propagationStopped,
    event,
  }
}

/** The phases of `window` and `document` around an element path: both listen in capture, `document` then `window` bubble. */
function propagationHooks(scoped?: GpuixEventTarget): Required<DomDispatchHooks> {
  // When `document` is the target, both its capture and bubble listeners run at the target.
  const documentPhase = (event: DomEvent, phase: number) =>
    event.target === document ? EVENT_PHASE_AT_TARGET : phase
  return {
    beforeCapture(event, state, fail) {
      window.run(event, state, true, EVENT_PHASE_CAPTURING, fail)
      if (!state.propagationStopped) {
        document.run(event, state, true, documentPhase(event, EVENT_PHASE_CAPTURING), fail)
      }
    },
    afterBubble(event, state, fail) {
      document.run(event, state, false, documentPhase(event, EVENT_PHASE_BUBBLING), fail)
      if (!state.propagationStopped) window.run(event, state, false, EVENT_PHASE_BUBBLING, fail)
      if (!state.propagationStopped) scoped?.run(event, state, false, EVENT_PHASE_BUBBLING, fail)
    },
  }
}

/** An event with no element path: aimed at the window or at `document`, which only they hear. */
function walkAtTop(
  event: DomEvent,
  state: DispatchState,
  hooks: Required<DomDispatchHooks>,
  fail: (error: unknown) => void
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
 * (`path`, target first), with `window` and `document` around them, as one Ghia delivered does.
 * Listeners of a element that is not connected hear it alone. A listener that throws goes to
 * `report`, after the walk.
 */
export function dispatchEventAlongPath(
  event: Event,
  path: readonly object[],
  handlersAt: HandlersAt,
  connected: boolean,
  report: (error: unknown) => void
): void {
  const state = beginDispatch(event, path[0] ?? document)
  state.path = path
  const errors: unknown[] = []
  walkDomEvent(
    event as unknown as DomEvent,
    state,
    path,
    handlersAt,
    connected ? propagationHooks() : undefined,
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
