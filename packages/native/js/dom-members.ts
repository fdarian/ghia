import {
  type ElementListeners,
  type ElementEventListener,
  type ElementListenerOptions,
} from "./events/element-listeners.js"
import { readLayoutSize } from "./bounds.js"
import type { NativeRenderer } from "./host.js"
import { document, type GpuixDocument } from "./events/window-target.js"

/** The DOM members every host element has beside the scroll ones. */
export interface DomElement {
  /** The `document` of the app. `document.defaultView` is the global `window`. */
  readonly ownerDocument: GpuixDocument
  /** Whether the element is in the tree of a mounted root. */
  readonly isConnected: boolean
  /**
   * The prop of that name (case-insensitive) as a string, or `null` when the element was not given
   * it. `false` is `null` and `true` is `""`, except for `data-*` and `aria-*`, which hold "true" and "false".
   */
  getAttribute(name: string): string | null
  /** The border box's width, rounded, before any transform. 0 for an element with no box. */
  readonly offsetWidth: number
  /** The border box's height, rounded, before any transform. 0 for an element with no box. */
  readonly offsetHeight: number
  addEventListener(
    type: string,
    listener: ElementEventListener | null,
    options?: boolean | ElementListenerOptions
  ): void
  removeEventListener(
    type: string,
    listener: ElementEventListener | null,
    options?: boolean | Pick<ElementListenerOptions, "capture">
  ): void
}

export interface DomElementBinding {
  readonly listeners: ElementListeners
  readonly connected: boolean
  /** The renderer and id of the element while it is mounted. */
  readonly layout: { renderer: NativeRenderer; id: number } | undefined
  /** What the element was given: the props of a Solid element, of a React instance. */
  prop(name: string): unknown
  propNames(): Iterable<string>
}

/** The prop an attribute name stands for: HTML attribute names are case-insensitive, props are not. */
function propForAttribute(bound: DomElementBinding, name: string): unknown {
  const exact = bound.prop(name)
  if (exact !== undefined) return exact
  const lower = name.toLowerCase()
  for (const key of bound.propNames()) {
    if (key.toLowerCase() === lower) return bound.prop(key)
  }
  return undefined
}

/**
 * A prop as the string a DOM attribute holds, or null where the DOM would have no attribute. A
 * `data-*` or `aria-*` attribute holds "false" for false; any other boolean attribute is present
 * (empty) for true and absent for false.
 */
function attributeOf(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  const lower = name.toLowerCase()
  if (lower.startsWith("data-") || lower.startsWith("aria-")) return String(value)
  if (value === false) return null
  if (value === true) return ""
  return String(value)
}

/**
 * Defines the DOM members on `target`, which is a prototype or one instance. `bind` finds what is
 * behind `this`.
 */
export function defineDomMembers<This extends object>(
  target: object,
  bind: (self: This) => DomElementBinding
): void {
  Object.defineProperties(target, {
    ownerDocument: { configurable: true, get: () => document },
    isConnected: {
      configurable: true,
      get(this: This) {
        return bind(this).connected
      },
    },
    getAttribute: {
      configurable: true,
      writable: true,
      value(this: This, name: string) {
        const bound = bind(this)
        const value = propForAttribute(bound, name)
        return attributeOf(
          name,
          name.toLowerCase() === "class" && value === undefined ? propForAttribute(bound, "className") : value
        )
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: This) {
        const layout = bind(this).layout
        return layout ? Math.round(readLayoutSize(layout.renderer, layout.id).width) : 0
      },
    },
    offsetHeight: {
      configurable: true,
      get(this: This) {
        const layout = bind(this).layout
        return layout ? Math.round(readLayoutSize(layout.renderer, layout.id).height) : 0
      },
    },
    addEventListener: {
      configurable: true,
      writable: true,
      value(
        this: This,
        type: string,
        listener: ElementEventListener | null,
        options?: boolean | ElementListenerOptions
      ) {
        bind(this).listeners.addEventListener(type, listener, options)
      },
    },
    removeEventListener: {
      configurable: true,
      writable: true,
      value(
        this: This,
        type: string,
        listener: ElementEventListener | null,
        options?: boolean | Pick<ElementListenerOptions, "capture">
      ) {
        bind(this).listeners.removeEventListener(type, listener, options)
      },
    },
  })
}
