/**
 * The members of an element that are its attributes under another name or a fixed answer:
 * `hidden`, `tabIndex`, `isContentEditable`, `shadowRoot` and `assignedSlot`. They read and write
 * through `getAttribute` and `setAttribute`, so they follow a prop a framework committed and
 * a write reaches native as the attribute would.
 */

import type { Element } from "./nodes.js"

/** The tags whose `tabIndex` is 0 without an attribute, from the HTML standard. Ghia's own `select` is one. */
const FOCUSABLE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "area",
  "button",
  "frame",
  "iframe",
  "input",
  "object",
  "select",
  "textarea",
])

/** The DOM's "rules for parsing integers": leading white space, a sign, digits, and anything after them ignored. */
const LEADING_INTEGER = /^[ \t\n\f\r]*([+-]?\d+)/
const INT32_MAX = 2147483647

function parseTabIndex(text: string): number | undefined {
  const match = LEADING_INTEGER.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return value >= -INT32_MAX - 1 && value <= INT32_MAX ? value : undefined
}

/** A `summary` that is the first one in its `details` is a tab stop. */
function isMainSummary(element: Element): boolean {
  const parent = element.parentElement
  return element.localName === "summary" && parent !== null && parent.localName === "details" && parent.children.find((child) => child.localName === "summary") === element
}

export interface ReflectedMembers {
  /** The `hidden` attribute. `"until-found"` reads back as that text, and any other value of the attribute is `true`. */
  hidden: boolean | "until-found"
  /** The `tabindex` attribute as an integer, or the tag's default: 0 for a control, a link and the like, -1 for the rest. */
  tabIndex: number
  /** Always `false`: Ghia has no `contenteditable`. */
  readonly isContentEditable: boolean
  /** Always `null`: there is no shadow DOM. */
  readonly shadowRoot: null
  /** Always `null`: there are no slots. */
  readonly assignedSlot: null
}

/** Defines the members on `target`, which is the prototype of `Element`. */
export function defineReflectedMembers(target: object): void {
  Object.defineProperties(target, {
    hidden: {
      configurable: true,
      get(this: Element) {
        const text = this.getAttribute("hidden")
        if (text === null) return false
        return text.toLowerCase() === "until-found" ? "until-found" : true
      },
      set(this: Element, value: unknown) {
        if (typeof value === "string" && value.toLowerCase() === "until-found") this.setAttribute("hidden", "until-found")
        else if (value) this.setAttribute("hidden", "")
        else this.removeAttribute("hidden")
      },
    },
    tabIndex: {
      configurable: true,
      get(this: Element) {
        const text = this.getAttribute("tabindex")
        if (text !== null) {
          const parsed = parseTabIndex(text)
          if (parsed !== undefined) return parsed
        }
        return FOCUSABLE_TAGS.has(this.localName) || isMainSummary(this) ? 0 : -1
      },
      set(this: Element, value: unknown) {
        const number = Math.trunc(Number(value))
        this.setAttribute("tabindex", String(Number.isFinite(number) ? number : 0))
      },
    },
    isContentEditable: { configurable: true, get: () => false },
    shadowRoot: { configurable: true, get: () => null },
    assignedSlot: { configurable: true, get: () => null },
  })
}
