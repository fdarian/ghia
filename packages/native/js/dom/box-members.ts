/**
 * The members that say where an element's box is, which a library that positions a popup or an
 * indicator reads beside `getBoundingClientRect`: `offsetParent`, `offsetLeft`, `offsetTop`,
 * `clientLeft`, `clientTop` and `getClientRects`. All of them read the box native laid out
 * (`getElementBounds`) at the time of the read, never a copy.
 */

import { getComputedStyle } from "../computed-style.js"
import { readElementBounds } from "../bounds.js"
import type { ElementBounds } from "../../index.js"
import type { NativeRenderer } from "../host.js"
import { DOMRect, DOMRectList } from "./dom-rect.js"
import type { Element } from "./nodes.js"

/** What the members need of an element: where it is mounted. */
export interface BoxBinding {
  readonly layout: { renderer: NativeRenderer; id: number } | undefined
}

type StyledElement = Parameters<typeof getComputedStyle>[0]

function boundsOf(element: Element, bind: (self: Element) => BoxBinding): ElementBounds | null {
  const layout = bind(element).layout
  return layout === undefined ? null : readElementBounds(layout.renderer, layout.id)
}

function positionOf(element: Element): string {
  return getComputedStyle(element as unknown as StyledElement).position
}

/** A cell or a table is the offset parent of a statically positioned element, as a positioned box is. */
const TABLE_PARTS: ReadonlySet<string> = new Set(["table", "td", "th"])

/**
 * The CSSOM View rule: nothing for an element with no box, for `html` and `body` and for a `fixed`
 * one; else the nearest ancestor that is positioned (or, for a static element, a table part),
 * ending at `body`. An ancestor that only has a transform is not one (see the deviations).
 */
function offsetParentOf(element: Element, bind: (self: Element) => BoxBinding): Element | null {
  if (boundsOf(element, bind) === null) return null
  if (element.localName === "html" || element.localName === "body") return null
  const own = positionOf(element)
  if (own === "fixed") return null
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (ancestor.localName === "body") return ancestor
    if (positionOf(ancestor) !== "static") return ancestor
    if (own === "static" && TABLE_PARTS.has(ancestor.localName)) return ancestor
  }
  return null
}

type Edge = "left" | "top"

/**
 * The distance from the padding edge of the offset parent to the border edge of the element, with
 * no transform and no scroll in it: a scroll offset of the ancestors moves the boxes the
 * rects are read from and not the layout `offsetLeft` describes, so it is put back. Without an
 * offset parent it is the distance from the window's origin. Rounded, as the DOM does.
 */
function offsetOf(element: Element, edge: Edge, bind: (self: Element) => BoxBinding): number {
  const own = boundsOf(element, bind)
  if (own === null) return 0
  const parent = offsetParentOf(element, bind)
  const axis = edge === "left" ? ("x" as const) : ("y" as const)
  if (parent === null) return Math.round(own[axis])
  let distance = own[axis]
  if (parent.localName !== "body" || positionOf(parent) !== "static") {
    const outer = boundsOf(parent, bind)
    if (outer === null) throw new Error("The offset parent of an element with a box has no box")
    distance -= outer[axis] + (edge === "left" ? outer.clientLeft : outer.clientTop)
  }
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    distance += edge === "left" ? ancestor.scrollLeft : ancestor.scrollTop
    if (ancestor === parent) break
  }
  return Math.round(distance)
}

/** Defines the box members on `target`, which is a prototype or one instance. */
export function defineBoxMembers(target: object, bind: (self: Element) => BoxBinding): void {
  Object.defineProperties(target, {
    offsetParent: {
      configurable: true,
      get(this: Element) {
        return offsetParentOf(this, bind)
      },
    },
    offsetLeft: {
      configurable: true,
      get(this: Element) {
        return offsetOf(this, "left", bind)
      },
    },
    offsetTop: {
      configurable: true,
      get(this: Element) {
        return offsetOf(this, "top", bind)
      },
    },
    clientLeft: {
      configurable: true,
      get(this: Element) {
        const bounds = boundsOf(this, bind)
        return bounds === null ? 0 : bounds.clientLeft
      },
    },
    clientTop: {
      configurable: true,
      get(this: Element) {
        const bounds = boundsOf(this, bind)
        return bounds === null ? 0 : bounds.clientTop
      },
    },
    getClientRects: {
      configurable: true,
      writable: true,
      value(this: Element) {
        const bounds = boundsOf(this, bind)
        const rects = new DOMRectList()
        if (bounds !== null) rects.push(new DOMRect(bounds.x, bounds.y, bounds.width, bounds.height))
        return rects
      },
    },
  })
}
