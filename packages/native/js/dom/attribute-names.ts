/**
 * The attribute a prop is, by the name the DOM gives it. An element is given props (`tabIndex`,
 * `className`), and `getAttributeNames`, `getAttribute` and `MutationRecord.attributeName` say
 * attributes (`tabindex`, `class`), so every place that turns one into the other goes through here.
 */

/** HTML names are lowercase in the DOM; SVG names keep their case (`viewBox`), as in Chrome. */
export function attributeNameOf(prop: string, svg: boolean): string {
  if (prop === "className") return "class"
  if (svg) return prop
  if (prop === "htmlFor") return "for"
  return prop.toLowerCase()
}

/** The name `getAttribute(name)` looks for: HTML names are case-insensitive, SVG names are not. */
export function attributeLookupName(name: string, svg: boolean): string {
  return svg ? name : name.toLowerCase()
}

/** Props that are not attributes: `getAttributeNames` skips them. `style` is an attribute: its text is `element.style.cssText`. */
export const NOT_ATTRIBUTES: ReadonlySet<string> = new Set(["children", "key", "ref"])

/**
 * How `setAttribute` turns the text of an attribute into the prop it stands for, as the browser's
 * reflection does: a number attribute is the integer it holds, a boolean attribute is on when it
 * is present whatever its value, and `draggable`, which is enumerated, is on for "true".
 */
type AttributeKind = "number" | "presence" | "true-text"

const WRITTEN_AS_PROP: Readonly<Record<string, { prop: string; kind?: AttributeKind }>> = {
  class: { prop: "className" },
  for: { prop: "htmlFor" },
  tabindex: { prop: "tabIndex", kind: "number" },
  colspan: { prop: "colSpan", kind: "number" },
  rowspan: { prop: "rowSpan", kind: "number" },
  span: { prop: "span", kind: "number" },
  maxlength: { prop: "maxLength", kind: "number" },
  autofocus: { prop: "autoFocus", kind: "presence" },
  readonly: { prop: "readOnly", kind: "presence" },
  inert: { prop: "inert", kind: "presence" },
  disabled: { prop: "disabled", kind: "presence" },
  hidden: { prop: "hidden", kind: "presence" },
  required: { prop: "required", kind: "presence" },
  checked: { prop: "checked", kind: "presence" },
  multiple: { prop: "multiple", kind: "presence" },
  selected: { prop: "selected", kind: "presence" },
  open: { prop: "open", kind: "presence" },
  draggable: { prop: "draggable", kind: "true-text" },
}

const INTEGER = /^\s*[+-]?\d+\s*$/

/**
 * Attributes with no prop behind them: the ones `getAttributeNames` skips, and `on*`. (`style` is the declaration's.) A write is
 * kept for `getAttribute` and reaches nothing else.
 */
export function isStoredAttribute(attribute: string): boolean {
  return NOT_ATTRIBUTES.has(attribute) || attribute.startsWith("on")
}

/**
 * The prop that `setAttribute(attribute, text)` writes and the value it gives it; `undefined` is
 * `removeAttribute`. `existingProp` is the key the element already holds for that attribute, which
 * keeps the name the framework used (`class` in Solid, `className` in React).
 */
export function propWrittenBy(
  attribute: string,
  text: string | null,
  existingProp: string | undefined
): { prop: string; value: string | number | boolean | undefined } {
  const entry = WRITTEN_AS_PROP[attribute]
  const prop = existingProp ?? entry?.prop ?? attribute
  if (text === null) return { prop, value: undefined }
  switch (entry?.kind) {
    case "number":
      // A text that is no integer stays as it is: `getAttribute` gives it back and native ignores it.
      return { prop, value: INTEGER.test(text) ? Number(text) : text }
    case "presence":
      return { prop, value: true }
    case "true-text":
      return { prop, value: text === "true" }
    default:
      return { prop, value: text }
  }
}

/** Attributes written to elements that have no prop for them (`style`, `onclick`), by element. */
const storedAttributes = new WeakMap<object, Map<string, string>>()

export function storedAttribute(element: object, attribute: string): string | undefined {
  return storedAttributes.get(element)?.get(attribute)
}

export function storedAttributeNames(element: object): string[] {
  const stored = storedAttributes.get(element)
  return stored === undefined ? [] : [...stored.keys()]
}

/** `null` removes it. Gives what it held before. */
export function storeAttribute(element: object, attribute: string, text: string | null): string | undefined {
  let stored = storedAttributes.get(element)
  const before = stored?.get(attribute)
  if (text === null) {
    stored?.delete(attribute)
  } else {
    if (stored === undefined) {
      stored = new Map()
      storedAttributes.set(element, stored)
    }
    stored.set(attribute, text)
  }
  return before
}
