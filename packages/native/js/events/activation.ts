import { flushPendingMutations } from "../bounds.js"
import type { NativeRenderer } from "../host.js"
import { requiredWriter } from "../dom/renderer-writer.js"
import { MouseEvent } from "./classes.js"
import { followLinkOnClick } from "./link-activation.js"

const NO_ACTIVATION = "a dispatched click has no activation behaviour"

type ClickTarget = { renderer: NativeRenderer; id: number } | undefined

/** A `click` that is a `MouseEvent`, one an app built included, has the activation behaviour of the DOM. */
function activates(target: ClickTarget, event: Event): target is NonNullable<ClickTarget> {
  return target !== undefined && event.type === "click" && isMouseEvent(event)
}

/**
 * What the DOM does at the start of `dispatchEvent(click)`: the legacy-pre-activation of the
 * activation target, which for a checkbox or radio is its toggle, made before any listener runs
 * so that a click handler reads the new `checked`.
 */
export function preActivateClick(target: ClickTarget, event: Event): void {
  if (!activates(target, event)) return
  const preActivate = requiredWriter(target.renderer, "preActivateElement", NO_ACTIVATION)
  flushPendingMutations(target.renderer)
  preActivate(target.id)
}

/**
 * What the DOM does after `dispatchEvent(click)`. A listener that canceled the click puts the
 * toggle of `preActivateClick` back. Otherwise it is the activation behaviour of the element's
 * activation target. Native owns the behaviours that exist (`events/activation.rs`: a label
 * focuses its control and clicks it, a submit button submits its form, a checkbox or radio fires
 * `input` and `change`), so this only asks it to run them.
 */
export function activateAfterClick(target: ClickTarget, event: Event): void {
  if (!activates(target, event)) return
  if (event.defaultPrevented) requiredWriter(target.renderer, "cancelActivation", NO_ACTIVATION)(target.id)
  else requiredWriter(target.renderer, "activateElement", NO_ACTIVATION)(target.id)
}

/**
 * The activation behaviour of a link, for a click an app dispatched: native has none for `<a>`, and the
 * clicks native makes are followed where they are delivered (`runRootEvent`). `path` is the event's path, target first.
 */
export function followLinkAfterClick(path: readonly object[], event: Event): void {
  if (event.type !== "click" || !isMouseEvent(event) || event.defaultPrevented) return
  followLinkOnClick(path)
}

function isMouseEvent(event: Event): boolean {
  if (event instanceof MouseEvent) return true
  const runtimeMouseEvent: unknown = Reflect.get(globalThis, "MouseEvent")
  return typeof runtimeMouseEvent === "function" && event instanceof (runtimeMouseEvent as new () => object)
}
