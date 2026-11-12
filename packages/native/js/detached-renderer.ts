/**
 * What a renderer answers once its window is gone: the test renderer after `dispose()` (or after
 * the next test renderer replaced it), a live renderer once its window closed.
 *
 * A library keeps references to elements past the unmount of the root that made them: Base UI
 * returns focus from a timer, floating-ui measures in a microtask, a drag library reads a rect in
 * a `pointerup`. In a browser a removed node answers like a node that is not in the document (a
 * zero rect, an empty computed style, `focus()` does nothing), so the members that reach the
 * renderer do the same here instead of throwing, or in the test renderer's case, reaching the
 * window of the next test.
 *
 * Only the members an element can reach are listed. Anything else a renderer has (the test
 * renderer's simulated input, its frame and screenshot calls) keeps failing, because the code that
 * calls it is a test or an app that holds the renderer itself.
 */

import type { NativeRenderer } from "./host.js"

type Method = (...args: never[]) => unknown

const noop = (): void => {}
const returnNull = (): null => null
const returnFalse = (): boolean => false
const returnEmptyList = (): never[] => []

const DETACHED: Readonly<Record<string, Method>> = {
  // Writes. Style, attribute and listener changes are batches, so a removed node's own state still
  // changes (it lives on the JS node) and native, which has no element for it, hears nothing.
  applyBatch: returnEmptyList,
  focusElement: noop,
  blurElement: noop,
  focusNext: noop,
  focusPrevious: noop,
  focusNextWithin: noop,
  focusPreviousWithin: noop,
  blur: noop,
  setWindowKeyEvents: noop,
  setWindowEventListeners: noop,
  setWindowSelectionChange: noop,
  setWindowAppearanceChange: noop,
  setWindowMediaChange: noop,
  scrollTo: noop,
  scrollToItem: noop,
  scrollIntoView: noop,
  scrollByKey: noop,
  setPointerCapture: noop,
  releasePointerCapture: noop,
  clickElement: noop,
  activateElement: noop,
  preActivateElement: noop,
  cancelActivation: noop,
  writeInputFlag: noop,
  writeRangeValue: noop,
  restoreControlledState: noop,
  cancelDrag: noop,
  requestPointerLock: noop,
  exitPointerLock: noop,
  setImage: noop,
  setStyleImage: noop,
  failStyleImage: noop,
  setImagePixels: noop,
  selectText: noop,
  setSelectionRange: noop,
  requestSubmit: noop,
  clearSelection: noop,
  webviewCommand: noop,
  pauseAnimation: noop,
  playAnimation: noop,
  cancelAnimation: noop,
  finishAnimation: noop,
  reverseAnimation: noop,
  setAnimationCurrentTime: noop,
  setAnimationPlaybackRate: noop,
  updateAnimationPlaybackRate: noop,
  setAnimationStartTime: noop,
  updateAnimationTiming: noop,
  releaseAnimation: noop,
  forgetAnimation: noop,
  // The cleanups of a motion value that outlives its element.
  disposeMotionValue: returnFalse,
  stopMotionValue: noop,
  detachMotionValueClock: noop,
  setMotionValueListener: noop,
  // Frame callbacks have no window to wait for.
  requestAnimationFrame: returnFalse,

  // Reads of an element that is not in a document.
  getElementBounds: returnNull,
  probeElementBounds: returnNull,
  getBuiltElementBounds: returnNull,
  getScrollMetrics: returnNull,
  getScrollOffset: returnNull,
  getListScrollTop: returnNull,
  getComputedStyle: returnNull,
  getFocusedElementId: returnNull,
  pointerLockElement: returnNull,
  getSelectedText: returnNull,
  matchesFocus: returnFalse,
  hasPointerCapture: returnFalse,
  getElementsAt: returnEmptyList,
  getAnimations: returnEmptyList,
  getSubtreeAnimations: returnEmptyList,
  getDocumentAnimations: returnEmptyList,
  getPaintedHighlights: returnEmptyList,
  getTextValue: () => "",
  getTextSelection: () => ({ start: 0, end: 0, direction: "none" }),
  getInputChoice: () => ({
    kind: "text",
    checked: false,
    defaultChecked: false,
    indeterminate: false,
    value: "",
    min: 0,
    max: 0,
    step: 0,
  }),
}

const detached = new WeakSet<object>()

/** A renderer that never had a window: every element-facing method answers as `detachRenderer` makes them. */
export function createDetachedRenderer(): NativeRenderer {
  const renderer = {}
  for (const name of Object.keys(DETACHED)) Reflect.set(renderer, name, DETACHED[name])
  detached.add(renderer)
  return renderer as NativeRenderer
}

/**
 * Makes the element-facing methods of `renderer` answer as for a node that is not in a document.
 * Methods the renderer does not have stay absent, since callers read "optional method missing" as
 * "this renderer cannot do that". Calling it again does nothing.
 */
export function detachRenderer(renderer: object): void {
  if (detached.has(renderer)) return
  detached.add(renderer)
  for (const name of Object.keys(DETACHED)) {
    if (typeof Reflect.get(renderer, name) !== "function") continue
    Object.defineProperty(renderer, name, {
      value: DETACHED[name],
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
}
