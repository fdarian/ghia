import type { EventPayload } from "../../index.js"
import type { EventHandlerMap, HostEventHandler } from "../host.js"
import type { HostDropEffect } from "./types.js"

/**
 * What the handler map holds under a key that has an event listener list (`ElementListeners`). It
 * is callable like any handler; the dispatch calls the function under `LISTENER_RUNNER` instead, to
 * give it the state of the dispatch.
 */
export const LISTENER_RUNNER = Symbol.for("@ghia/native/listener-runner")

export interface ListenerRunner {
  (event: DomEvent): void
  readonly [LISTENER_RUNNER]: (
    event: DomEvent,
    state: DomEventState | undefined,
    fail: (error: unknown) => void
  ) => void
}

function isListenerRunner(handler: HostEventHandler): handler is HostEventHandler & ListenerRunner {
  return LISTENER_RUNNER in handler
}

export const EVENT_PHASE_NONE = 0
export const EVENT_PHASE_CAPTURING = 1
export const EVENT_PHASE_AT_TARGET = 2
export const EVENT_PHASE_BUBBLING = 3

/**
 * Types that neither bubble nor can be cancelled. Types are compared
 * case-insensitively because native types are camelCase (`mouseEnter`) and DOM
 * names are lowercase (`mouseenter`).
 */
const PLAIN_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "mouseenter",
  "mouseleave",
  "pointerenter",
  "pointerleave",
  "focus",
  "blur",
  "load",
  "error",
  "scroll",
  "selectionchange",
  "did-start-loading",
  "did-stop-loading",
  "did-navigate",
  "page-title-updated",
  "did-fail-load",
  "attach",
  "detach",
  "resize",
])

/**
 * Non-bubbling types an ancestor hears in the capture phase only. Native is told
 * about their capture listeners apart from the bubble ones (see
 * `nativeEventType`), so it can skip the event where no one above is capturing.
 */
const ENTER_LEAVE_TYPES: ReadonlySet<string> = new Set([
  "mouseenter",
  "mouseleave",
  "pointerenter",
  "pointerleave",
])

export function isEnterLeaveType(eventType: string): boolean {
  return ENTER_LEAVE_TYPES.has(eventType)
}

/** Types that do not bubble. Everything else bubbles. `invalid` is cancelable. */
const NON_BUBBLING_TYPES: ReadonlySet<string> = new Set([...PLAIN_NOTIFICATIONS, "invalid"])

/** `preventDefault()` is a no-op on these, as in the DOM. */
const NON_CANCELABLE_TYPES: ReadonlySet<string> = new Set([
  ...PLAIN_NOTIFICATIONS,
  "focusin",
  "focusout",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "transitionrun",
  "transitionstart",
  "transitionend",
  "transitioncancel",
  "animationstart",
  "animationiteration",
  "animationend",
  "animationcancel",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "pointerlockchange",
  "pointerlockerror",
])

const POINTER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "gotpointercapture",
  "lostpointercapture",
  // Chrome makes these PointerEvents too.
  "click",
  "auxclick",
  "contextmenu",
])

/** Clicks that a keyboard, an assistive technology or `el.click()` makes have no pointer (`pointerId` -1). */
const CLICK_TYPES: ReadonlySet<string> = new Set(["click", "auxclick", "contextmenu"])

function isPrimaryPointer(payload: EventPayload, eventType: string): boolean {
  return !CLICK_TYPES.has(eventType) || payload.pointerId !== -1
}

export function eventBubbles(eventType: string): boolean {
  return !NON_BUBBLING_TYPES.has(eventType.toLowerCase())
}

export function eventIsCancelable(eventType: string): boolean {
  return !NON_CANCELABLE_TYPES.has(eventType.toLowerCase())
}

/**
 * Key of a capture-phase handler in `EventHandlerMap`: the event type plus
 * `"Capture"`, next to the bubble-phase handler registered under the bare type.
 */
export function captureHandlerKey(eventType: string): string {
  return `${eventType}Capture`
}

/**
 * What a handler sees of the native payload: every field but the three that
 * carry element ids, which the event replaces with elements. `elementId` stays
 * the numeric id of the element the payload was addressed to.
 */
export type PublicEventFields = Omit<EventPayload, "target" | "relatedTarget" | "path" | "data" | "submitterId"> & {
  /** `null` for an edit that inserted no text, see `HostInputEvent`. */
  data?: string | null
}

/**
 * An event with no propagation, such as `onSelectionChange` or
 * `onAppearanceChange`: the payload with its elements in place of their ids.
 * An element is the object a `ref` gives in the adapter (React's host
 * instance, Solid's element).
 */
export interface RootEvent extends PublicEventFields {
  /**
   * The element the event was aimed at. `null` for an event aimed at the
   * window: a key with nothing focused, a pointer move outside every element.
   * GPUIX has no `body` or `html` element to stand in. The `document` object
   * for `pointerlockchange` and `pointerlockerror`, as in the DOM.
   */
  readonly target: object | null
  /** The other element of a boundary or focus event, or `null` when there is none. */
  readonly relatedTarget: object | null
}

/** The event object handlers receive: the native payload plus the DOM surface. */
export interface DomEvent extends RootEvent {
  readonly type: string
  /**
   * The element whose handler is running, or the `window` / `document` object
   * during their phases. `null` outside a dispatch.
   */
  currentTarget: object | null
  /** The elements on the propagation path, target first, like the DOM's `composedPath()`. */
  composedPath(): object[]
  /** The event itself, as a synthetic event wrapper's `nativeEvent` is the DOM event under it. */
  readonly nativeEvent: DomEvent
  /** Whether a pointer event is from the primary pointer: Ghia has one pointer, so `true` on any event a pointer made and `false` on a click no pointer made. Absent on other events. */
  readonly isPrimary?: boolean
  eventPhase: number
  readonly bubbles: boolean
  readonly cancelable: boolean
  readonly timeStamp: number
  defaultPrevented: boolean
  stopPropagation(): void
  stopImmediatePropagation(): void
  preventDefault(): void
}

export interface DomDispatchResult {
  defaultPrevented: boolean
  propagationStopped: boolean
  /** Set for a `dragover`: what the drop would do. */
  dropEffect?: HostDropEffect
}

export interface DomEventRoot {
  eventHandlers: EventHandlerMap
  /**
   * The element for a native element id, as the adapter's ref gives it, or
   * `undefined` once the root has dropped it.
   */
  elementById(id: number): object | undefined
  /**
   * Where an error a handler throws goes: the renderer's `onError`. Without it
   * the error is reported to the global handler, as the DOM does.
   */
  reportError?: (error: unknown) => void
}

/** What `stopPropagation()` and `stopImmediatePropagation()` have done so far. */
export interface DomEventState {
  readonly propagationStopped: boolean
  readonly immediatePropagationStopped: boolean
}

/**
 * Phases that belong outside the element tree: `window` and `document` wrap
 * the path. They run with the live event, so a `preventDefault()` or
 * `stopPropagation()` on either side is seen by the other.
 */
export interface DomDispatchHooks {
  /**
   * Before the first capture handler. Skipped phases follow `state`. A throw
   * of a listener goes to `fail` so the dispatch goes on.
   */
  beforeCapture?(event: DomEvent, state: DomEventState, fail: (error: unknown) => void): void
  /**
   * After the last bubble handler, for an event that bubbles and was not stopped.
   * A throw of a listener goes to `fail`.
   */
  afterBubble?(event: DomEvent, state: DomEventState, fail: (error: unknown) => void): void
}

/** What a form's `submit` event adds: the `FormData` and the button that submitted, `null` for `requestSubmit()` and for Enter in a form with no submit button. */
function formSubmission(
  root: DomEventRoot,
  entries: string[][],
  submitter: number | undefined
): { formData: FormData; submitter: object | null } {
  const formData = new FormData()
  for (const [name, value] of entries) formData.append(name, value)
  return { formData, submitter: optionalElement(root, submitter) }
}

/** The element for `id`, or throws: the root dropped an element native still names. */
export function requireElement(root: DomEventRoot, id: number, eventType: string): object {
  const element = root.elementById(id)
  if (element === undefined) {
    throw new Error(`Event "${eventType}" names element ${id}, which its root does not have.`)
  }
  return element
}

/**
 * The element for an id native may not have sent. `null` for no id, and for an
 * element the root has already dropped: one that left the tree is not the other
 * end of a boundary or focus event any more.
 */
export function optionalElement(root: DomEventRoot, id: number | undefined): object | null {
  if (id == null) return null
  const element = root.elementById(id)
  return element === undefined ? null : element
}

/** The payload as a public event: element ids replaced by the elements they name. */
export function toRootEvent(root: DomEventRoot, payload: EventPayload, target: object | null): RootEvent {
  const fields: PublicEventFields & Partial<Pick<EventPayload, "target" | "relatedTarget" | "path" | "submitterId">> = {
    ...payload,
  }
  delete fields.submitterId
  delete fields.target
  delete fields.relatedTarget
  delete fields.path
  return { ...fields, target, relatedTarget: optionalElement(root, payload.relatedTarget) }
}

/**
 * Creates the event object and the state behind its stop methods. `path` is
 * the propagation path as elements, target first; empty for an event aimed at
 * the window or the document, whose `target` is `pathlessTarget`.
 */
export function createDomEvent(
  root: DomEventRoot,
  payload: EventPayload,
  path: readonly object[],
  pathlessTarget: object | null
): { event: DomEvent; state: DomEventState } {
  const state = { propagationStopped: false, immediatePropagationStopped: false }
  const cancelable = eventIsCancelable(payload.eventType)
  const event: DomEvent = {
    ...toRootEvent(root, payload, path[0] ?? pathlessTarget),
    ...(payload.formEntries && formSubmission(root, payload.formEntries, payload.submitterId)),
    // An edit has no data unless it inserted text, and the DOM says so with null.
    ...(payload.eventType === "change" && { data: payload.data ?? null }),
    ...(POINTER_EVENT_TYPES.has(payload.eventType.toLowerCase()) && {
      isPrimary: isPrimaryPointer(payload, payload.eventType.toLowerCase()),
    }),
    type: payload.eventType,
    currentTarget: null,
    composedPath: () => [...path],
    get nativeEvent() {
      return event
    },
    eventPhase: EVENT_PHASE_NONE,
    bubbles: eventBubbles(payload.eventType),
    cancelable,
    timeStamp: performance.now(),
    defaultPrevented: false,
    stopPropagation() {
      state.propagationStopped = true
    },
    stopImmediatePropagation() {
      state.propagationStopped = true
      state.immediatePropagationStopped = true
    },
    preventDefault() {
      if (cancelable) event.defaultPrevented = true
    },
  }
  return { event, state }
}

/**
 * What the DOM does with an exception a listener leaves uncaught: report it to
 * the global error handler without disturbing the dispatch or its caller.
 */
export function reportUncaught(error: unknown): void {
  if (typeof reportError === "function") {
    reportError(error)
    return
  }
  queueMicrotask(() => {
    throw error
  })
}

/** Reports the errors a dispatch collected, once it is over. */
export function reportHandlerErrors(root: DomEventRoot, errors: readonly unknown[]): void {
  errors.forEach(root.reportError ?? reportUncaught)
}

/**
 * Runs `payload` through the handlers registered on `root`: capture handlers
 * from the root down to the target, then the target's, then bubble handlers
 * from the target back up, along `payload.path` (target first). Handlers run
 * synchronously. A payload without `path` is handled at `payload.elementId`
 * only. A handler that throws does not end the dispatch: the error goes to
 * `root.reportError` (or the global handler) after the dispatch, and the rest
 * of the handlers run.
 */
export function dispatchDomEvent(
  root: DomEventRoot,
  payload: EventPayload,
  hooks?: DomDispatchHooks
): DomDispatchResult {
  const path = payload.path ?? [payload.elementId]
  if (path.length === 0) {
    throw new Error(`Event "${payload.eventType}" has an empty propagation path.`)
  }
  const target = path[0]
  if (payload.path && payload.target != null && payload.target !== target) {
    throw new Error(
      `Event "${payload.eventType}" targets element ${payload.target} but its path starts at ${target}.`
    )
  }

  const elements = path.map((id) => requireElement(root, id, payload.eventType))
  const { event, state } = createDomEvent(root, payload, elements, null)
  const errors: unknown[] = []
  const fail = (error: unknown) => errors.push(error)
  const captureKey = captureHandlerKey(payload.eventType)
  const visit = (index: number, phase: number, keys: string[]) => {
    event.currentTarget = elements[index]
    event.eventPhase = phase
    const handlers = root.eventHandlers.get(path[index])
    if (!handlers) return
    for (const key of keys) {
      if (state.immediatePropagationStopped) return
      const handler = handlers.get(key)
      if (!handler) continue
      try {
        // An element with listeners on this type keeps a list, which needs the state of the dispatch.
        if (isListenerRunner(handler)) handler[LISTENER_RUNNER](event, state, fail)
        else handler(event)
      } catch (error) {
        fail(error)
      }
    }
  }

  hooks?.beforeCapture?.(event, state, fail)
  for (let index = path.length - 1; index > 0 && !state.propagationStopped; index--) {
    visit(index, EVENT_PHASE_CAPTURING, [captureKey])
  }
  if (!state.propagationStopped) {
    visit(0, EVENT_PHASE_AT_TARGET, [captureKey, payload.eventType])
  }
  if (event.bubbles) {
    for (let index = 1; index < path.length && !state.propagationStopped; index++) {
      visit(index, EVENT_PHASE_BUBBLING, [payload.eventType])
    }
  }
  if (event.bubbles && !state.propagationStopped) hooks?.afterBubble?.(event, state, fail)

  event.currentTarget = null
  event.eventPhase = EVENT_PHASE_NONE
  reportHandlerErrors(root, errors)
  return {
    defaultPrevented: event.defaultPrevented,
    propagationStopped: state.propagationStopped,
  }
}

/**
 * `event.preventDefault()` for a handler typed with the plain payload. Throws
 * for an event that did not come through `dispatchDomEvent`, where there is no
 * default to cancel.
 */
export function preventEventDefault(event: PublicEventFields): void {
  const cancelable = event as Partial<DomEvent>
  if (!cancelable.preventDefault) {
    throw new Error(`Event "${event.eventType}" cannot be cancelled: it was not dispatched through the DOM walk.`)
  }
  cancelable.preventDefault()
}
