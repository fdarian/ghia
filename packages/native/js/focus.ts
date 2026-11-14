import { HOST_BINDING, type ObservableElement } from "./bounds.js"
import { readComputedStyle } from "./computed-style.js"
import type { NativeRenderer } from "./host.js"

export interface FocusOptions {
  /** Skip scrolling the element into view. Defaults to false, like the DOM. */
  preventScroll?: boolean
}

/** The focus methods of a DOM element, shared by every adapter's element refs. */
export interface FocusableElement {
  focus(options?: FocusOptions): void
  blur(): void
}

function required<Method>(method: Method | undefined, name: string): Method {
  if (!method) throw new Error(`This GPUIX renderer does not support ${name}`)
  return method
}

/** A host element as `focus()` takes it: the element and the chain of its ancestors, whose `display` decides whether it is rendered. */
export interface FocusableHost extends ObservableElement {
  readonly parentElement: object | null
}

/**
 * Whether `element` or an ancestor is `display: none` (its own style, a stylesheet rule or the `hidden`
 * attribute), which leaves it without a box. `display` is not inherited, so each ancestor is read. The
 * reads flush the pending mutations first, as a browser flushes style before `focus()`, so an element
 * mounted in this tick is judged by what it has now.
 */
function isNotRendered(renderer: NativeRenderer, element: FocusableHost): boolean {
  const own = readComputedStyle(renderer, element.nativeId, false)
  // Not in the document: a removed element does not take focus either.
  if (own === undefined) return true
  if (own.get("display") === "none") return true
  // Ancestors of a host element are host elements, up to the stand-ins that have no native element.
  let ancestor = element.parentElement as FocusableHost | null
  while (ancestor !== null && ancestor[HOST_BINDING]() !== undefined) {
    if (readComputedStyle(renderer, ancestor.nativeId, false)?.get("display") === "none") return true
    ancestor = ancestor.parentElement as FocusableHost | null
  }
  return false
}

/**
 * `element.focus()`. Does nothing for an element that is not in a mounted root, or that is not being
 * rendered (`display: none` on it or an ancestor), as in a browser.
 */
export function focusHostElement(element: FocusableHost, options?: FocusOptions): void {
  const binding = element[HOST_BINDING]()
  if (binding === undefined) return
  const renderer = binding.renderer
  // A renderer that cannot read styles (the web renderer) cannot tell, so it focuses as it always did.
  if (renderer.getComputedStyle !== undefined && isNotRendered(renderer, element)) return
  required(renderer.focusElement, "focus()").call(renderer, element.nativeId)
  if (!options?.preventScroll) scrollFocusIntoView(renderer, element.nativeId)
}

/** Tab and Shift+Tab. The renderer scrolls the new focus into view itself. */
export function moveFocusByTab(renderer: NativeRenderer, backwards: boolean): void {
  const move = backwards ? renderer.focusPrevious : renderer.focusNext
  move?.call(renderer)
}

/** Browsers scroll a newly focused element to its nearest edge, and only if it is not in view. */
function scrollFocusIntoView(renderer: NativeRenderer, id: number): void {
  renderer.scrollIntoView?.(id, "nearest", "nearest")
}

export function blurHostElement(renderer: NativeRenderer | undefined, id: number): void {
  if (renderer === undefined) return
  required(renderer.blurElement, "blur()").call(renderer, id)
}

/**
 * Whether the element is in the state one of `:focus`, `:focus-visible`, `:focus-within`, `:hover` and
 * `:active` names. Native answers those five and throws for any other selector, so only the
 * selector engine (`dom/selectors.ts`) calls this, with exactly those.
 */
export function hostElementMatches(renderer: NativeRenderer, id: number, selector: string): boolean {
  return required(renderer.matchesFocus, "the :focus and :hover selectors").call(renderer, id, selector)
}
