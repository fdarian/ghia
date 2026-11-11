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
  // The `checked` and `value` attributes of an `<input>` are its defaults: the properties are `checked` and `value`.
  if (prop === "defaultChecked") return "checked"
  if (prop === "defaultValue") return "value"
  return lowerCased(prop)
}

/** The input types whose `value` attribute is the value itself (the HTML spec's "default" and "default/on" value modes). */
const VALUE_IS_ATTRIBUTE = new Set(["checkbox", "radio", "hidden", "submit", "button", "reset", "image"])

/**
 * The prop that holds an `<input>`'s `checked` or `value` attribute, where it is not the prop of that
 * name: the attribute is `defaultChecked`, and for the types with the "value" value mode (text,
 * range, number, ...) `defaultValue`, which is the value only while the control is clean. The `value`
 * of a checkbox, radio or hidden input is its attribute, so it has none.
 */
export function inputDefaultProp(attribute: string, inputType: unknown): "defaultChecked" | "defaultValue" | undefined {
  if (attribute === "checked") return "defaultChecked"
  if (attribute !== "value") return undefined
  return VALUE_IS_ATTRIBUTE.has(String(inputType).toLowerCase()) ? undefined : "defaultValue"
}

/** `toLowerCase` that allocates only for a name with a capital: an adapter asks for every prop of every element. */
function lowerCased(prop: string): string {
  for (let index = 0; index < prop.length; index += 1) {
    const code = prop.charCodeAt(index)
    if (code >= 65 && code <= 90) return prop.toLowerCase()
  }
  return prop
}

/** The name `getAttribute(name)` looks for: HTML names are case-insensitive, SVG names are not. */
export function attributeLookupName(name: string, svg: boolean): string {
  return svg ? name : name.toLowerCase()
}

/** Whether a prop is not an attribute: `getAttributeNames` skips it. `style` is one: its text is `element.style.cssText`. */
export function isNotAttribute(prop: string): boolean {
  return prop === "children" || prop === "key" || prop === "ref"
}

/**
 * How `setAttribute` turns the text of an attribute into the prop it stands for, as the browser's
 * reflection does: a number attribute is the integer it holds, a boolean attribute is on when it
 * is present whatever its value, and `draggable`, which is enumerated, is on for "true".
 */
type AttributeKind = "number" | "presence" | "true-text" | "until-found"

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
  hidden: { prop: "hidden", kind: "until-found" },
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
  return isNotAttribute(attribute) || attribute.startsWith("on")
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
    case "until-found":
      // `hidden="until-found"` is its own state: it keeps its box, so it is the text and not a presence.
      return { prop, value: text.toLowerCase() === "until-found" ? "until-found" : true }
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

/** Whether a prop is not sent to native as an attribute: native builds the `[style]` text from the element's own style declarations. */
export function isNotNativeAttribute(prop: string): boolean {
  return prop === "style" || isNotAttribute(prop)
}

/**
 * A prop as the string a DOM attribute holds, or null where the DOM would have no attribute. A
 * `data-*` or `aria-*` attribute holds "false" for false; any other boolean attribute is present
 * (empty) for true and absent for false.
 */
export function attributeText(name: string, value: unknown): string | null {
  switch (typeof value) {
    case "string":
      return value
    case "number":
      return String(value)
    case "boolean":
      if (holdsBooleanText(name)) return String(value)
      return value ? "" : null
    case "undefined":
    case "function":
    case "object":
      // A handler or a style object is not an attribute: there is no text to give for it.
      return null
    default:
      return String(value)
  }
}

function holdsBooleanText(name: string): boolean {
  const lower = lowerCased(name)
  return lower.startsWith("data-") || lower.startsWith("aria-")
}

/**
 * The attributes an element given `props` has, by name. Two props can name one attribute
 * (`class` and `className`): the one written as the attribute wins, else the first.
 */
export function attributesOfProps(props: Iterable<readonly [string, unknown]>, svg: boolean): Map<string, string> {
  const values = new Map<string, unknown>()
  for (const [prop, value] of props) {
    if (isNotNativeAttribute(prop) || value === undefined) continue
    const name = attributeNameOf(prop, svg)
    if (!values.has(name) || prop === name) values.set(name, value)
  }
  const attributes = new Map<string, string>()
  for (const [name, value] of values) {
    const text = attributeText(name, value)
    if (text !== null) attributes.set(name, text)
  }
  return attributes
}
