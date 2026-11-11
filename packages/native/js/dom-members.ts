import {
  type ElementListeners,
  type ElementEventListener,
  type ElementListenerOptions,
} from "./events/element-listeners.js"
import { readLayoutSize } from "./bounds.js"
import type { NativeRenderer } from "./host.js"
import { document, type GpuixDocument } from "./events/window-target.js"
import { attributeLookupName, attributeNameOf, attributeText } from "./dom/attribute-names.js"
import { DOM_BINDING, SVGElement, type Element } from "./dom/nodes.js"
import { popoverProperty } from "./dom/popover-attribute.js"
import { hidePopover, showPopover, togglePopover, writePopoverAttribute } from "./dom/popover.js"
import { serializeStyle } from "./dom/css-style-declaration.js"
import type { StyleDesc } from "./host.js"

/** The DOM members every host element has beside the scroll ones. */
export interface DomElement {
  /** The `document` of the app. `document.defaultView` is the global `window`. */
  readonly ownerDocument: GpuixDocument
  /** Whether the element is in the tree of a mounted root. */
  readonly isConnected: boolean
  /**
   * The prop of that name (case-insensitive) as a string, or `null` when the element was not given
   * it, or when it is a function or an object (`onClick`). `style` is the text of the live style
   * (`width: 10px; --x: 1;`), `null` while it has no declaration. `false` is `null` and `true` is `""`, except for `data-*` and `aria-*`, which hold "true" and "false".
   */
  getAttribute(name: string): string | null
  /**
   * The HTML popover API, for an element with a `popover` attribute: `showPopover()` opens it, in the
   * top layer, and fires `beforetoggle` (cancelable) and then `toggle`; `hidePopover()` closes it;
   * `togglePopover(force?)` does either and says whether it is open. Showing a showing popover and
   * hiding a hidden one do nothing. They throw `NotSupportedError` without the attribute and
   * `InvalidStateError` for an element that is not in the document.
   */
  showPopover(): void
  hidePopover(): void
  togglePopover(force?: boolean): boolean
  /**
   * The `popover` attribute limited to its known values (`""` is `"auto"`, an unknown value
   * `"manual"`), or `null` without one. Setting it to `null` or `undefined` takes the attribute
   * away; a showing popover that is not the same kind afterwards is hidden, with its events.
   */
  get popover(): "auto" | "manual" | "hint" | null
  set popover(value: string | null | undefined)
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
  /** The live style, read when `getAttribute("style")` asks for it. */
  readonly style: StyleDesc
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
        if (String(name).toLowerCase() === "style") {
          const text = serializeStyle(bind(this).style)
          return text === "" ? null : text
        }
        return attributeText(name, propForAttribute(bind(this), name, this instanceof SVGElement))
      },
    },
    showPopover: {
      configurable: true,
      writable: true,
      value(this: This) {
        showPopover(this as unknown as Element, () => bind(this))
      },
    },
    hidePopover: {
      configurable: true,
      writable: true,
      value(this: This) {
        hidePopover(this as unknown as Element, () => bind(this))
      },
    },
    togglePopover: {
      configurable: true,
      writable: true,
      value(this: This, force?: boolean | { force?: boolean }) {
        return togglePopover(this as unknown as Element, () => bind(this), force)
      },
    },
    popover: {
      configurable: true,
      get(this: This) {
        return popoverProperty((this as unknown as Element).getAttribute("popover"))
      },
      set(this: This, value: string | null | undefined) {
        const element = this as unknown as Element
        const text = value === null || value === undefined ? null : String(value)
        writePopoverAttribute(element, () => element[DOM_BINDING]().setProp("popover", text === null ? false : text))
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
