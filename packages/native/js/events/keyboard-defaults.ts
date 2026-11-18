import type { EventPayload } from "../../index.js"
import { flushPendingMutations } from "../bounds.js"
import type { KeyEvent, NativeRenderer } from "../host.js"
import type { ActiveRoot, DismissLayer } from "../renderer-state.js"
import {
  captureHandlerKey,
  createDomEvent,
  dispatchDomEvent,
  optionalElement,
  reportHandlerErrors,
  requireElement,
  toRootEvent,
  type DomDispatchResult,
  type DomEvent,
  type PublicEventFields,
  type RootEvent,
} from "./dispatch.js"
import type { Element } from "../dom/nodes.js"
import { paintedSelectionTookOver } from "../dom/selection.js"
import { editingHostOf } from "../editing/host.js"
import { focusedNode, runEditingInput } from "../editing/input.js"
import { scrollKeyName } from "../scroll.js"
import { moveFocusByTab } from "../focus.js"
import { isDragEvent } from "./drag.js"
import { handlerEventType, hasDomListener, isOutsidePress } from "./route.js"
import {
  dispatchPropagating,
  dispatchSelectionChange,
  document,
  isDocumentEvent,
  listensForSelectionChange,
  wantsNativeSelectionChange,
  window,
} from "./window-target.js"

export interface RootEventContext {
  readonly renderer: NativeRenderer
  topLayer(): DismissLayer | undefined
  dispatchDrag(root: ActiveRoot, event: EventPayload): DomDispatchResult["dropEffect"]
}

const notHandled: DomDispatchResult = { defaultPrevented: false, propagationStopped: false }

function hasCommandModifier(event: PublicEventFields): boolean {
  const modifiers = event.modifiers
  return Boolean(modifiers?.ctrl || modifiers?.alt || modifiers?.cmd)
}

const KEY_EVENT_TYPES: ReadonlySet<string> = new Set(["keydown", "keyup"])

const MOVE_EVENT_TYPES: ReadonlySet<string> = new Set(["pointermove", "mousemove"])

/** A move over no element: it has no path, and only `window` and `document` hear it. */
function isWindowMove(event: EventPayload): boolean {
  return event.path == null && MOVE_EVENT_TYPES.has(event.eventType)
}

/**
 * Native may still emit the old camelCase pointer names; handlers are
 * registered under the DOM's lowercase ones.
 */
export function normalizeEventType(event: EventPayload): EventPayload {
  const eventType = handlerEventType(event.eventType)
  return eventType === event.eventType ? event : { ...event, eventType }
}

/** Whether `event` was meant for the live root, and something is there to hear it. */
export function handlesEvent(root: ActiveRoot, event: EventPayload): boolean {
  if (event.eventType === "selectionChange") {
    return (
      event.elementId === root.windowSelectionEventId &&
      (Boolean(root.handlers.onSelectionChange) || wantsNativeSelectionChange())
    )
  }
  if (event.eventType === "appearanceChange") {
    return event.elementId === root.windowAppearanceEventId && Boolean(root.handlers.onAppearanceChange)
  }
  // A path whose target the root has dropped is an event native queued before
  // the element was destroyed: nobody can be told about it.
  if (event.path != null && event.path.length > 0 && root.elementById(event.path[0]) === undefined) {
    return false
  }
  // Document-level in the DOM, so no element id or listener flag: native
  // fires them only for a lock JS asked for or held.
  if (isDocumentEvent(event.eventType)) {
    return window.hasListeners(event.eventType) || document.hasListeners(event.eventType)
  }
  if (KEY_EVENT_TYPES.has(event.eventType)) {
    // Native aims a key at the window when nothing focused listens; that
    // address goes stale when the root is replaced.
    return event.path != null || event.elementId === root.windowKeyEventId
  }
  if (isDragEvent(event)) return true
  if (isWindowMove(event)) {
    return window.hasListeners(event.eventType) || document.hasListeners(event.eventType)
  }
  if (event.path == null || isOutsidePress(event.eventType)) {
    const handlers = root.eventHandlers.get(event.elementId)
    return (
      handlers?.has(event.eventType) === true ||
      (event.path == null && handlers?.has(captureHandlerKey(event.eventType)) === true)
    )
  }
  return (
    hasDomListener(root.eventHandlers, event) ||
    window.hasListeners(event.eventType) ||
    document.hasListeners(event.eventType)
  )
}

/** An event of the window (selection, appearance), with `target` as the element when it names one. */
function windowLevelEvent(root: ActiveRoot, event: EventPayload): RootEvent {
  return { ...toRootEvent(root, event, optionalElement(root, event.target)), elementId: 0 }
}

export function runRootEvent(
  root: ActiveRoot,
  event: EventPayload,
  context: RootEventContext
): DomDispatchResult {
  if (event.eventType === "selectionChange") {
    // `value` is the painted text, absent after a clear: a clear is not a replacement of a node selection.
    if (event.value != null) paintedSelectionTookOver()
    root.handlers.onSelectionChange?.(windowLevelEvent(root, event), context.renderer)
    if (listensForSelectionChange()) dispatchSelectionChange(root, event)
    return notHandled
  }
  if (event.eventType === "appearanceChange") {
    root.handlers.onAppearanceChange?.(windowLevelEvent(root, event), context.renderer)
    return notHandled
  }
  if (isDocumentEvent(event.eventType)) {
    dispatchPropagating(root, event, root.scoped)
    return notHandled
  }
  if (isDragEvent(event)) {
    const dropEffect = context.dispatchDrag(root, event)
    return dropEffect === undefined ? notHandled : { ...notHandled, dropEffect }
  }
  if (isOutsidePress(event.eventType)) {
    try {
      const path = (event.path ?? [event.elementId]).map((id) => requireElement(root, id, event.eventType))
      const outside = createDomEvent(root, event, path, null).event
      outside.currentTarget = requireElement(root, event.elementId, event.eventType)
      root.eventHandlers.get(event.elementId)?.get(event.eventType)?.(outside)
    } catch (error) {
      reportHandlerErrors(root, [error])
    }
    return notHandled
  }
  if (event.path == null && !KEY_EVENT_TYPES.has(event.eventType) && !isWindowMove(event)) {
    // Aimed at one element, with no path to walk, but still cancelable.
    return dispatchDomEvent(root, event)
  }
  const { event: domEvent, ...result } = dispatchPropagating(root, event, root.scoped)
  if (event.eventType === "keydown" && !result.defaultPrevented) {
    return { ...result, handled: runKeyDefault(root, domEvent, context) }
  }
  return result
}

const ELEMENT_NODE = 1
const TEXT_CONTROLS: ReadonlySet<string> = new Set(["input", "textarea"])

/**
 * The edit a key makes in an editing host as its own default action: a paragraph or line break and the
 * deletions. A key that types text is not here: native gives the text to the host through the platform's
 * input handler, which is where the input method, dead keys and the emoji picker come in too.
 */
function editingInputOf(key: string | undefined, shift: boolean): string | undefined {
  if (key === "Enter") return shift ? "insertLineBreak" : "insertParagraph"
  if (key === "Backspace") return "deleteContentBackward"
  if (key === "Delete") return "deleteContentForward"
  return undefined
}

/** Whether the key was an edit of an editing host: native then keeps the platform from typing it. */
function editInEditingHost(event: DomEvent): boolean {
  // A key the input method is composing with is the input method's: what it does with the key is the edit.
  if (event.isComposing) return false
  const inputType = editingInputOf(event.key, Boolean(event.modifiers?.shift))
  if (inputType === undefined) return false
  const focused = focusedNode()
  if (editingHostOf(focused) === null || (focused.nodeType === ELEMENT_NODE && TEXT_CONTROLS.has((focused as Element).localName))) {
    return false
  }
  return runEditingInput(inputType, null).handled
}

// The default actions of a key run after every handler had the chance to
// call preventDefault().
function runKeyDefault(root: ActiveRoot, event: DomEvent, context: RootEventContext): boolean {
  if (hasCommandModifier(event)) return false
  if (editInEditingHost(event)) {
    // The next thing the platform asks (the selection, the next key's insert) reads the new tree.
    flushPendingMutations(context.renderer)
    return true
  }
  if (event.key === "Escape") {
    context.topLayer()?.onEscapeKeyDown(event as KeyEvent)
  } else if (event.key === "Tab" && root.handlers.tabNavigation !== false) {
    moveFocusByTab(context.renderer, Boolean(event.modifiers?.shift))
  } else {
    const scrollKey = scrollKeyName(event.key)
    if (scrollKey) context.renderer.scrollByKey?.(scrollKey, Boolean(event.modifiers?.shift))
  }
  return false
}
