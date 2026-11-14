import { HOST_BINDING, flushPendingMutations, type ObservableElement } from "./bounds.js"
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

/**
 * `element.focus()`. Does nothing for an element a browser's `focus()` would refuse: not in a mounted
 * root, not rendered (`display: none` on it or an ancestor), `visibility: hidden` or `collapse`, or
 * inside an `inert` subtree. The queued mutations are sent first, as a browser flushes style before
 * `focus()`, so an element mounted or shown in this tick is judged by what it has now; native then
 * decides and moves focus in one call, with no layout.
 */
export function focusHostElement(element: ObservableElement, options?: FocusOptions): void {
  const binding = element[HOST_BINDING]()
  if (binding === undefined) return
  const renderer = binding.renderer
  flushPendingMutations(renderer)
  // The web renderer's `focusElement` returns nothing and takes the focus as it always did.
  const asked = required(renderer.focusElement, "focus()").call(renderer, element.nativeId)
  if (asked === false) return
  if (!options?.preventScroll) scrollFocusIntoView(renderer, element.nativeId)
}

/**
 * `renderer.focusElement(id)` after the queued mutations are sent, so native judges the element by
 * what it has now (a `tabIndex`, `display` or `inert` written in the same update). For code that
 * has an id and no element; `focusHostElement` is `element.focus()`.
 */
export function focusElementById(renderer: NativeRenderer, id: number): void {
  flushPendingMutations(renderer)
  renderer.focusElement?.(id)
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
