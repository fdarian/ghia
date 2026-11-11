import {
  DOM_LISTENERS,
  type ElementListeners,
  type ElementEventListener,
  type ElementListenerOptions,
} from "./events/element-listeners.js"
import { activateAfterClick, preActivateClick } from "./events/activation.js"
import { reportUncaught } from "./events/dispatch.js"
import { createRendererState } from "./renderer-state.js"
import { readLayoutSize } from "./bounds.js"
import type { NativeRenderer } from "./host.js"
import { dispatchEventAlongPath, document, type GpuixDocument } from "./events/window-target.js"
import {
  attributeLookupName,
  attributeNameOf,
  attributeText,
  isStoredAttribute,
  propWrittenBy,
  storeAttribute,
  storedAttribute,
} from "./dom/attribute-names.js"
import { hasMutationObservers, queueAttributeMutation } from "./dom/mutation-observer.js"
import {
  styleAttributeOf,
  styleDeclarationOf,
  writeStyleAttribute,
  type StyleBinding,
} from "./dom/style-declaration.js"
import { Element, SVGElement, type Node } from "./dom/nodes.js"
import { defineInputMembers } from "./dom/input-members.js"
import { defineBoxMembers } from "./dom/box-members.js"
import type { DOMRectList } from "./dom/dom-rect.js"

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
   * that prop overwrites it; an attribute it never set stays. `style` is `style.cssText`; `on*`
   * is kept for `getAttribute` only. See docs/fork/deviations.md.
   */
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  /**
   * The inline style: the framework's `style` prop with what this declaration wrote over it. A
   * write reaches native before the next frame and before any read of layout. A framework
   * commit that changes a property replaces the written value. Assigning a string sets `cssText`.
   * See docs/fork/deviations.md for what is stored and not applied.
   */
  style: CSSStyleDeclaration
  /** The border box's width, rounded, before any transform. 0 for an element with no box. */
  readonly offsetWidth: number
  /** The border box's height, rounded, before any transform. 0 for an element with no box. */
  readonly offsetHeight: number
  /**
   * The nearest ancestor that is positioned (`position` is not `static`), a table part for a static
   * element, or `body`: what `offsetLeft` and `offsetTop` are measured from. `null` for an
   * element with no box (not mounted, `display: none`), for `html`, `body` and a `fixed` element.
   */
  readonly offsetParent: Element | null
  /** The distance from the padding edge of `offsetParent` to the element's border edge, rounded, as laid out: a transform is not in it and neither is a scroll. 0 for an element with no box. */
  readonly offsetLeft: number
  readonly offsetTop: number
  /** The widths of the left and top borders, rounded. 0 for an element with no box. */
  readonly clientLeft: number
  readonly clientTop: number
  /**
   * The element's border box in window coordinates, as one rect in a `DOMRectList`: an empty list for an
   * element with no box. An inline box that wraps over lines is one rect, the box around all its lines.
   */
  getClientRects(): DOMRectList
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
  /**
   * Dispatches an event the app built (`new Event`, `new CustomEvent`, `new PointerEvent`) at the
   * element, as one Ghia delivers: capture from the top down, the target, then the bubble phase
   * if the event bubbles, heard by `on*` props, `addEventListener` listeners, and `document` and
   * `window` when the element is connected. Returns false when a listener called `preventDefault()`
   * on a cancelable event. Throws an `InvalidStateError` for an event already being dispatched.
   * The dispatched event's `isTrusted` is false.
   */
  dispatchEvent(event: Event): boolean
}

export interface DomElementBinding extends StyleBinding {
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

/** The element and its ancestors that are elements, target first: the path of an event dispatched at it. */
function pathFrom(target: Element): Element[] {
  const path: Element[] = []
  for (let node: Node | null = target; node instanceof Element; node = node.parentNode) path.push(node)
  return path
}

function listenersOf(node: object): ElementListeners | undefined {
  const read: unknown = Reflect.get(node, DOM_LISTENERS)
  return typeof read === "function" ? (read.call(node) as ElementListeners) : undefined
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
  if (attribute === "style") {
    writeStyleAttribute(styleDeclarationOf(element, () => bound), text)
    return
  }
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
 * Defines the DOM members on `target`, which is a prototype or one instance. `bind` finds what is
 * behind `this`.
 */
export function defineDomMembers<This extends object>(
  target: object,
  bind: (self: This) => DomElementBinding
): void {
  defineInputMembers(target, bind)
  defineBoxMembers(target, bind as unknown as (self: Element) => DomElementBinding)
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
        if (attributeLookupName(name, svg) === "style") {
          return styleAttributeOf(styleDeclarationOf(this as unknown as Element, () => bind(this)))
        }
        const stored = storedAttribute(this, attributeLookupName(name, svg))
        if (stored !== undefined) return stored
        return attributeText(name, propForAttribute(bind(this), name, svg))
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
    style: {
      configurable: true,
      get(this: This) {
        return styleDeclarationOf(this as unknown as Element, () => bind(this))
      },
      set(this: This, text: string) {
        styleDeclarationOf(this as unknown as Element, () => bind(this)).cssText = text
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
    [DOM_LISTENERS]: {
      configurable: true,
      value(this: This) {
        return bind(this).listeners
      },
    },
    dispatchEvent: {
      configurable: true,
      writable: true,
      value(this: This, event: Event) {
        const bound = bind(this)
        const path = pathFrom(this as unknown as Element)
        const report = bound.layout ? createRendererState(bound.layout.renderer).reportError : reportUncaught
        // A click toggles a checkbox or radio before its listeners run, and puts it back when one cancels it.
        preActivateClick(bound.layout, event)
        dispatchEventAlongPath(event, path, (index) => listenersOf(path[index]), bound.connected, report)
        activateAfterClick(bound.layout, event)
        return !event.defaultPrevented
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
