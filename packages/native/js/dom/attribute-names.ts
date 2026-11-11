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

/** Props that are not attributes: `element.attributes` skips them, and so does what is sent to native. */
export const NOT_ATTRIBUTES: ReadonlySet<string> = new Set(["children", "key", "ref", "style"])

/**
 * A prop as the string a DOM attribute holds, or null where the DOM would have no attribute. A
 * `data-*` or `aria-*` attribute holds "false" for false; any other boolean attribute is present
 * (empty) for true and absent for false.
 */
export function attributeText(name: string, value: unknown): string | null {
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
