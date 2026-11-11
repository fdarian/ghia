import type { ElementType } from "../host.js"
import { isHtmlTag } from "../html-tags.js"
import { SVG_CHILD_TYPES } from "../svg.js"

/** The element types Ghia names itself, apart from the SVG shapes and the HTML tags that are `div`s. */
const GHIA_ELEMENT_TYPES: ReadonlySet<string> = new Set<ElementType>([
  "html",
  "head",
  "body",
  "div",
  "text",
  "span",
  "img",
  "svg",
  "canvas",
  "input",
  "textarea",
  "label",
  "form",
  "anchored",
  "code",
  "diff",
  "markdown",
  "webview",
  "nativeview",
  "virtual-list",
  "style",
])

/** Whether `type` is one of the element types Ghia draws, as written (`div`, `linearGradient`). */
export function isElementType(type: string): type is ElementType {
  return GHIA_ELEMENT_TYPES.has(type) || SVG_CHILD_TYPES.has(type) || isHtmlTag(type)
}

/** The element types that are SVG elements: `svg` and what only lives inside it. */
export function isSvgElementType(type: string): boolean {
  return type === "svg" || SVG_CHILD_TYPES.has(type)
}
