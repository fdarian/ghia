/**
 * The HTML popover API on elements: `showPopover()`, `hidePopover()` and `togglePopover()`, with
 * `beforetoggle` and `toggle`, light dismiss for `popover="auto"` and the top layer natively.
 *
 * Whether a popover is open is not an attribute, so it is not a prop either: it is kept here, per
 * element, and native is told through the custom prop `popoverOpen` (the show order, absent while
 * closed), which `native/src/html/popover.rs` reads. It is sent straight to the renderer and never
 * stored in the adapter's props, so `getAttribute`, `getAttributeNames` and `cloneNode` cannot see it.
 *
 * A popover that left the document is no longer showing, and no event is sent, as the spec's
 * removing steps do. The record goes when native destroys the element (`popoversDestroyed`, called
 * where the mutation queue applies a batch) and when its window closes (`popoversOfRendererGone`);
 * it is also checked against the element each time it is used (`current`), which catches an
 * element that is out of the document but not yet destroyed.
 */

import { flushPendingMutations } from "../bounds.js"
import { dispatchAtElement, type DomEvent, type DomEventRoot } from "../events/dispatch.js"
import { document, elementOf } from "../events/window-target.js"
import type { DomElementBinding } from "../dom-members.js"
import type { NativeRenderer } from "../host.js"
import { namedError } from "../named-error.js"
import { createRendererState, pushDismissLayer } from "../renderer-state.js"
import { WireWriter } from "../wire.js"
import type { Element, Node } from "./nodes.js"
import { popoverKind, type PopoverKind } from "./popover-attribute.js"
import { ToggleEvent } from "./toggle-event.js"

/** What these functions read of an element, taken fresh each time: an adapter's binding is a view. */
export type PopoverProbe = () => Pick<DomElementBinding, "connected" | "layout">

/** The prop native reads the show order from: see `native/src/html/popover.rs`. */
export const POPOVER_OPEN_PROP = "popoverOpen"

type Showing = {
  readonly element: Element
  readonly kind: PopoverKind
  readonly renderer: NativeRenderer
  readonly id: number
  readonly probe: PopoverProbe
  /** Takes the layer that closes an `auto` popover on Escape off the stack. */
  removeLayer: (() => void) | undefined
}

const showing = new WeakMap<Element, Showing>()
/** The popovers that are showing, in the order they were shown. */
const open: Showing[] = []
let shownCount = 0

function kindOf(element: Element): PopoverKind | null {
  return popoverKind(element.getAttribute("popover"))
}

/** The record of `element` while it is still showing; one that went stale is dropped, with no event. */
function current(element: Element): Showing | undefined {
  const record = showing.get(element)
  if (record === undefined) return undefined
  const binding = record.probe()
  const unchanged =
    binding.connected &&
    binding.layout?.renderer === record.renderer &&
    binding.layout.id === record.id &&
    kindOf(element) !== null
  if (unchanged) return record
  forget(record, binding.layout?.renderer === record.renderer && binding.layout.id === record.id)
  return undefined
}

function forget(record: Showing, native: boolean): void {
  showing.delete(record.element)
  open.splice(open.indexOf(record), 1)
  record.removeLayer?.()
  record.removeLayer = undefined
  if (native) sendOpen(record.renderer, record.id, null)
  if (!open.some((other) => other.kind === "auto")) stopLightDismiss()
}

/**
 * Native destroyed these elements, and a destroyed element is closed: their records go, with no
 * events. A node code put back is made again under the same id, so a record that stayed would claim
 * a popover that is closed.
 */
export function popoversDestroyed(renderer: unknown, ids: readonly number[]): void {
  if (open.length === 0 || ids.length === 0) return
  const destroyed = new Set(ids)
  for (const record of open.slice()) {
    if (record.renderer === renderer && destroyed.has(record.id)) forget(record, false)
  }
}

/** The window of `renderer` closed: every popover of it is gone with it. */
export function popoversOfRendererGone(renderer: unknown): void {
  for (const record of open.slice()) {
    if (record.renderer === renderer) forget(record, false)
  }
}

function sendOpen(renderer: NativeRenderer, id: number, order: number | null): void {
  // What the framework queued (the element, its `popover` prop) reaches native first.
  flushPendingMutations(renderer)
  const writer = new WireWriter()
  writer.setCustomProp(id, POPOVER_OPEN_PROP, order)
  const batch = writer.finish()
  renderer.applyBatch(batch.wire)
  writer.release(batch)
}

function rootOf(renderer: NativeRenderer): DomEventRoot | undefined {
  const state = createRendererState(renderer)
  const root = state.current()
  if (root === undefined) return undefined
  return {
    eventHandlers: root.eventHandlers,
    elementById: (id) => elementOf(renderer, id),
    reportError: (error) => state.reportError(error),
  }
}

/** Sends the event to the listeners of the element and says whether none cancelled it. */
function fire(
  record: Pick<Showing, "renderer" | "id">,
  element: Element,
  type: "beforetoggle" | "toggle",
  oldState: "closed" | "open",
  newState: "closed" | "open",
  cancelable: boolean
): boolean {
  const root = rootOf(record.renderer)
  if (root === undefined) return true
  const event = new ToggleEvent(type, { oldState, newState, cancelable })
  dispatchAtElement(root, record.id, element, event)
  return !event.defaultPrevented
}

/** `toggle` is queued as a task. A second change before it runs takes the place of the first and keeps its old state. */
const pendingToggles = new WeakMap<Element, { oldState: "closed" | "open"; timer: ReturnType<typeof setTimeout> }>()

function queueToggle(
  record: Pick<Showing, "renderer" | "id">,
  element: Element,
  oldState: "closed" | "open",
  newState: "closed" | "open"
): void {
  const earlier = pendingToggles.get(element)
  if (earlier !== undefined) {
    clearTimeout(earlier.timer)
  }
  const from = earlier?.oldState ?? oldState
  const timer = setTimeout(() => {
    pendingToggles.delete(element)
    fire(record, element, "toggle", from, newState, false)
  }, 0)
  pendingToggles.set(element, { oldState: from, timer })
}

function requirePopover(element: Element, method: string): PopoverKind {
  const kind = kindOf(element)
  if (kind === null) {
    throw namedError("NotSupportedError", `Failed to execute '${method}' on 'HTMLElement': The element has no popover attribute.`)
  }
  return kind
}

function requireConnected(probe: PopoverProbe, method: string): NonNullable<ReturnType<PopoverProbe>["layout"]> {
  const binding = probe()
  if (!binding.connected || binding.layout === undefined) {
    throw namedError("InvalidStateError", `Failed to execute '${method}' on 'HTMLElement': Invalid on disconnected popover elements.`)
  }
  return binding.layout
}

/** The nearest ancestor of `element` that is a showing `auto` popover. */
function autoPopoverAbove(element: Element): Showing | undefined {
  for (let node: Node | null = element.parentNode; node !== null; node = node.parentNode) {
    const record = current(node as Element)
    if (record?.kind === "auto") return record
  }
  return undefined
}

/** Hides every showing `auto` popover of `renderer` shown after `until`, or all of them when it is `undefined`, latest first. */
function hideAutoPopoversAfter(renderer: NativeRenderer, until: Showing | undefined): void {
  const from = until === undefined ? 0 : open.indexOf(until) + 1
  for (const record of open.slice(from).reverse()) {
    if (record.kind !== "auto" || record.renderer !== renderer) continue
    if (current(record.element) === record) hide(record, true)
  }
}

function hide(record: Showing, fireEvents: boolean): void {
  if (record.kind === "auto") hideAutoPopoversAfter(record.renderer, record)
  if (current(record.element) !== record) return
  if (fireEvents) {
    fire(record, record.element, "beforetoggle", "open", "closed", false)
    // A listener can have hidden it, or taken the attribute away.
    if (current(record.element) !== record) return
  }
  forget(record, true)
  if (fireEvents) queueToggle(record, record.element, "open", "closed")
}

export function showPopover(element: Element, probe: PopoverProbe): void {
  const kind = requirePopover(element, "showPopover")
  if (current(element) !== undefined) return
  const layout = requireConnected(probe, "showPopover")
  const pending = { renderer: layout.renderer, id: layout.id }
  if (!fire(pending, element, "beforetoggle", "closed", "open", true)) return
  // A listener can have shown it, removed it, or taken the attribute away.
  if (kindOf(element) === null || current(element) !== undefined) return
  const after = probe()
  if (!after.connected || after.layout?.renderer !== layout.renderer || after.layout.id !== layout.id) return
  if (kind === "auto") hideAutoPopoversAfter(layout.renderer, autoPopoverAbove(element))
  if (current(element) !== undefined || probe().layout?.id !== layout.id) return

  const record: Showing = { element, kind, renderer: layout.renderer, id: layout.id, probe, removeLayer: undefined }
  showing.set(element, record)
  open.push(record)
  sendOpen(record.renderer, record.id, ++shownCount)
  if (kind === "auto") {
    record.removeLayer = pushDismissLayer(record.renderer, { onEscapeKeyDown: () => hidePopover(element, probe) })
    startLightDismiss()
  }
  queueToggle(record, element, "closed", "open")
}

export function hidePopover(element: Element, probe: PopoverProbe): void {
  requirePopover(element, "hidePopover")
  const record = current(element)
  if (record === undefined) return
  requireConnected(probe, "hidePopover")
  hide(record, true)
}

export function togglePopover(element: Element, probe: PopoverProbe, force?: boolean | { force?: boolean }): boolean {
  const wanted = typeof force === "object" && force !== null ? force.force : force
  const isShowing = current(element) !== undefined
  if (isShowing && wanted !== true) hidePopover(element, probe)
  else if (!isShowing && wanted !== false) showPopover(element, probe)
  else {
    requirePopover(element, "togglePopover")
    requireConnected(probe, "togglePopover")
  }
  return current(element) !== undefined
}

/**
 * Code is about to set the `popover` attribute of `element` to `value` (`null` takes it away): a
 * popover that is showing and is not the same kind afterwards is hidden, with the events of any
 * hide. They run before the attribute changes, so a listener still reads the old one.
 */
export function popoverAttributeWillChange(element: Element, value: string | null): void {
  const record = current(element)
  if (record === undefined || popoverKind(value) === record.kind) return
  hide(record, true)
}

/** The showing `auto` popover that holds `target`: the nearest one of it or of an ancestor. */
function popoverHolding(target: unknown): Showing | undefined {
  for (let node = target as Node | null; node !== null && node !== undefined; node = node.parentNode) {
    const record = showing.get(node as Element)
    if (record !== undefined && record.kind === "auto" && current(node as Element) === record) return record
  }
  return undefined
}

/** A press outside the open `auto` popovers closes them, all of them but the one it is in and those it holds. */
function lightDismiss(event: DomEvent): void {
  const inside = popoverHolding(event.target)
  for (const record of open.slice().reverse()) {
    if (record.kind !== "auto") continue
    if (inside !== undefined && open.indexOf(record) <= open.indexOf(inside)) break
    if (current(record.element) === record) hide(record, true)
  }
}

let lightDismissing = false

function startLightDismiss(): void {
  if (lightDismissing) return
  lightDismissing = true
  document.addEventListener("pointerdown", lightDismiss, true)
}

function stopLightDismiss(): void {
  if (!lightDismissing) return
  lightDismissing = false
  document.removeEventListener("pointerdown", lightDismiss, true)
}
