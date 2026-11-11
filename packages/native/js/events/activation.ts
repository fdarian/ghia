import { flushPendingMutations } from "../bounds.js"
import type { NativeRenderer } from "../host.js"
import { MouseEvent } from "./classes.js"

type ClickTarget = { renderer: NativeRenderer; id: number } | undefined

/** A `click` that is a `MouseEvent`, one an app built included, has the activation behaviour of the DOM. */
function activates(target: ClickTarget, event: Event): target is NonNullable<ClickTarget> {
  return target !== undefined && event.type === "click" && isMouseEvent(event)
}

function required<Name extends "preActivateElement" | "cancelActivation" | "activateElement">(
  renderer: NativeRenderer,
  name: Name
): NonNullable<NativeRenderer[Name]> {
  const method = renderer[name]
  if (typeof method !== "function") {
    throw new Error(`This renderer does not support ${name}, so a dispatched click has no activation behaviour`)
  }
  return method.bind(renderer) as NonNullable<NativeRenderer[Name]>
}

/**
 * What the DOM does at the start of `dispatchEvent(click)`: the legacy-pre-activation of the
 * activation target, which for a checkbox or radio is its toggle, made before any listener runs
 * so that a click handler reads the new `checked`.
 */
export function preActivateClick(target: ClickTarget, event: Event): void {
  if (!activates(target, event)) return
  const preActivate = required(target.renderer, "preActivateElement")
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
  if (event.defaultPrevented) required(target.renderer, "cancelActivation")(target.id)
  else required(target.renderer, "activateElement")(target.id)
}

function isMouseEvent(event: Event): boolean {
  if (event instanceof MouseEvent) return true
  const runtimeMouseEvent: unknown = Reflect.get(globalThis, "MouseEvent")
  return typeof runtimeMouseEvent === "function" && event instanceof (runtimeMouseEvent as new () => object)
}
