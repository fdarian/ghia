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
  return lowerCased(prop)
}

const LOWER_CASED_LIMIT = 1024
const lowerCasedProps = new Map<string, string>()

/** `toLowerCase` of a prop name, remembered: an adapter asks for every prop of every element, and the names repeat. */
function lowerCased(prop: string): string {
  const known = lowerCasedProps.get(prop)
  if (known !== undefined) return known
  const lower = prop.toLowerCase()
  if (lowerCasedProps.size < LOWER_CASED_LIMIT) lowerCasedProps.set(prop, lower)
  return lower
}

/** The name `getAttribute(name)` looks for: HTML names are case-insensitive, SVG names are not. */
export function attributeLookupName(name: string, svg: boolean): string {
  return svg ? name : name.toLowerCase()
}

/** Props that are not attributes: `element.attributes` skips them, and so does what is sent to native. */
export const NOT_ATTRIBUTES: ReadonlySet<string> = new Set(["children", "key", "ref", "style"])

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
    if (NOT_ATTRIBUTES.has(prop) || value === undefined) continue
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
