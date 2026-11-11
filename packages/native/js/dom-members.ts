import {
  type ElementListeners,
  type ElementEventListener,
  type ElementListenerOptions,
} from "./events/element-listeners.js"
import { readLayoutSize } from "./bounds.js"
import type { NativeRenderer } from "./host.js"
import { document, type GpuixDocument } from "./events/window-target.js"
import {
  attributeLookupName,
  attributeNameOf,
  isStoredAttribute,
  propWrittenBy,
  storeAttribute,
  storedAttribute,
} from "./dom/attribute-names.js"
import { hasMutationObservers, queueAttributeMutation } from "./dom/mutation-observer.js"
import { SVGElement, type Element } from "./dom/nodes.js"

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
  /**
   * Writes the prop the attribute stands for, through the same path as a rendered prop, so native
   * has it at once and `getAttribute(name)` gives it back as text. A framework's next commit of
   * that prop overwrites it; an attribute it never set stays. `style` and `on*` are kept for
   * `getAttribute` only. See docs/fork/deviations.md.
   */
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
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
  /**
   * Sets the prop as the framework's own prop path does (`undefined` unsets it): the stored prop, the
   * native write, the observers' records, and a flush so native has it before the call returns.
   */
  writeProp(name: string, value: string | number | boolean | undefined): void
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

/** The key the element already holds for an attribute, whatever its value. */
function propKeyForAttribute(bound: DomElementBinding, attribute: string, svg: boolean): string | undefined {
  for (const key of bound.propNames()) {
    if (attributeNameOf(key, svg) === attribute) return key
  }
  return undefined
}

/** The DOM rejects an empty name and one with a space, a slash, `>`, `=` or NUL. */
const INVALID_NAME = /[\s\0/>=]|^$/

function writeAttribute(element: Element, bound: DomElementBinding, name: string, text: string | null): void {
  const svg = element instanceof SVGElement
  const requested = String(name)
  if (INVALID_NAME.test(requested)) {
    throw new DOMException(`'${requested}' is not a valid attribute name.`, "InvalidCharacterError")
  }
  const attribute = attributeLookupName(requested, svg)
  if (isStoredAttribute(attribute)) {
    const before = element.getAttribute(attribute)
    storeAttribute(element, attribute, text)
    if (hasMutationObservers() && element.getAttribute(attribute) !== before) {
      queueAttributeMutation(element, attribute, before)
    }
    return
  }
  const write = propWrittenBy(attribute, text, propKeyForAttribute(bound, attribute, svg))
  bound.writeProp(write.prop, write.value)
}

/**
 * A prop as the string a DOM attribute holds, or null where the DOM would have no attribute. A
 * `data-*` or `aria-*` attribute holds "false" for false; any other boolean attribute is present
 * (empty) for true and absent for false.
 */
function attributeOf(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  // A handler or a style object is not an attribute: there is no text to give for it.
  if (typeof value === "function" || typeof value === "object") return null
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
        const svg = this instanceof SVGElement
        const stored = storedAttribute(this, attributeLookupName(name, svg))
        if (stored !== undefined) return stored
        return attributeOf(name, propForAttribute(bind(this), name, svg))
      },
    },
    setAttribute: {
      configurable: true,
      writable: true,
      value(this: This, name: string, value: string) {
        writeAttribute(this as unknown as Element, bind(this), name, String(value))
      },
    },
    removeAttribute: {
      configurable: true,
      writable: true,
      value(this: This, name: string) {
        writeAttribute(this as unknown as Element, bind(this), name, null)
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
