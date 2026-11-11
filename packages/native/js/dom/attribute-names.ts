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
