/**
 * `HTMLLIElement.value`, `HTMLOListElement.start` and `HTMLOListElement.reversed`: the attributes
 * that number the markers of a list, as the DOM reflects them. They read and write through
 * `getAttribute` and `setAttribute`, so a write reaches native as `setAttribute` does, which is
 * where the markers read them.
 */

import type { Element } from "./nodes.js"
import { onTags } from "./tag-members.js"

const LIST_ITEM_TAG: ReadonlySet<string> = new Set(["li"])
const ORDERED_LIST_TAG: ReadonlySet<string> = new Set(["ol"])

/** The DOM's "rules for parsing integers": leading white space, a sign, digits, and anything after them ignored. */
const LEADING_INTEGER = /^[ \t\n\f\r]*([+-]?\d+)/
const INT32_MAX = 2147483647

/** The integer an attribute holds, `undefined` for text that is none or does not fit a `long`. */
export function parseHtmlInteger(text: string): number | undefined {
  const match = LEADING_INTEGER.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return value >= -INT32_MAX - 1 && value <= INT32_MAX ? value : undefined
}

/** A reflected `long`: the attribute's integer, or `fallback` for a missing or invalid one. Assigning writes `ToInt32` of the value. */
function longAttribute(name: string, fallback: number) {
  return {
    read: (element: Element) => {
      const text = element.getAttribute(name)
      return text === null ? fallback : (parseHtmlInteger(text) ?? fallback)
    },
    write: (element: Element, value: unknown) => element.setAttribute(name, String(Number(value) | 0)),
  }
}

const itemValue = longAttribute("value", 0)
const listStart = longAttribute("start", 1)

export function isListItem(element: object): boolean {
  return LIST_ITEM_TAG.has(Reflect.get(element, "localName") as string)
}

/** `value` of an `<li>`, `0` without a valid attribute. */
export function readListItemValue(element: object): number {
  return itemValue.read(element as Element)
}

export function writeListItemValue(element: object, value: unknown): void {
  itemValue.write(element as Element, value)
}

/** Defines `start` and `reversed` on `target`, the prototype of `Element`; on any tag but `<ol>` they read `undefined` and an assignment makes a plain property. */
export function defineListMembers(target: object): void {
  Object.defineProperties(target, {
    start: onTags<Element>("start", ORDERED_LIST_TAG, listStart.read, listStart.write),
    reversed: onTags<Element>(
      "reversed",
      ORDERED_LIST_TAG,
      (element) => element.getAttribute("reversed") !== null,
      (element, value) => (value ? element.setAttribute("reversed", "") : element.removeAttribute("reversed"))
    ),
  })
}
