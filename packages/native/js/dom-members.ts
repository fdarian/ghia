import {
  type ElementListeners,
  type ElementEventListener,
  type ElementListenerOptions,
} from "./events/element-listeners.js"
import { readLayoutSize } from "./bounds.js"
import type { NativeRenderer } from "./host.js"
import { document, type GpuixDocument } from "./events/window-target.js"
import { attributeLookupName, attributeNameOf, attributeText } from "./dom/attribute-names.js"
import { SVGElement } from "./dom/nodes.js"

/** The DOM members every host element has beside the scroll ones. */
export interface DomElement {
  /** The `document` of the app. `document.defaultView` is the global `window`. */
  readonly ownerDocument: GpuixDocument
  /** Whether the element is in the tree of a mounted root. */
  readonly isConnected: boolean
  /**
   * The prop of that name (case-insensitive) as a string, or `null` when the element was not given
   * it, or when it is a function or an object (`onClick`, `style`). `false` is `null` and `true` is `""`, except for `data-*` and `aria-*`, which hold "true" and "false".
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

/** The prop an attribute name stands for: `attributeNameOf` is the name a prop has as an attribute. */
function propForAttribute(bound: DomElementBinding, name: string, svg: boolean): unknown {
  const wanted = attributeLookupName(name, svg)
  const exact = bound.prop(wanted)
  if (exact !== undefined && attributeNameOf(wanted, svg) === wanted) return exact
  for (const key of bound.propNames()) {
    if (attributeNameOf(key, svg) !== wanted) continue
    const value = bound.prop(key)
    if (value !== undefined) return value
  }
  return undefined
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
        return attributeText(name, propForAttribute(bind(this), name, this instanceof SVGElement))
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
