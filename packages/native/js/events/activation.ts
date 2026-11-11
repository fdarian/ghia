import type { NativeRenderer } from "../host.js"
import { MouseEvent } from "./classes.js"

/**
 * What the DOM does after `dispatchEvent(click)` when no listener canceled it: the activation
 * behaviour of the element's activation target, for any `click` that is a `MouseEvent`, one an app
 * built included. Native owns the behaviours that exist (`events/activation.rs`: a label focuses its
 * control and clicks it, a submit button submits its form), so this only asks it to run them.
 *
 * A checkbox and a radio toggle in the same place, when they do: HTML's activation behaviour of
 * an `<input>` runs here, before native's.
 */
export function activateAfterClick(
  target: { renderer: NativeRenderer; id: number } | undefined,
  event: Event
): void {
  if (target === undefined || event.type !== "click" || event.defaultPrevented || !isMouseEvent(event)) return
  const activate = target.renderer.activateElement
  if (typeof activate !== "function") {
    throw new Error("This renderer does not support activateElement, so a dispatched click has no activation behaviour")
  }
  activate.call(target.renderer, target.id)
}

function isMouseEvent(event: Event): boolean {
  if (event instanceof MouseEvent) return true
  const runtimeMouseEvent: unknown = Reflect.get(globalThis, "MouseEvent")
  return typeof runtimeMouseEvent === "function" && event instanceof (runtimeMouseEvent as new () => object)
}
