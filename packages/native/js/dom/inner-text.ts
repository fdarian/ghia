/**
 * `innerText`, and the same text over a range: what a browser puts on the clipboard as `text/plain`
 * for a selection. It follows the "rendered text collection steps" of CSSOM View: a block-level
 * element is a line break on each side (a `<p>`, two), a `<br>` is a line feed, the white space of
 * ordinary text collapses, a table's cells are tab separated and its rows line separated, and the
 * breaks at either end are dropped.
 *
 * Which element is a block, hidden or preformatted is read from its tag and its `hidden` and inline
 * `style` attributes, as `Selection.toString` reads it: there is no CSS box to ask for an element
 * that is not mounted (docs/fork/deviations.md).
 */

import { DOM_BINDING, type Element, type Node, type ParentBinding } from "./nodes.js"
import type { Range } from "./range.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "html", "legend", "li", "main", "menu", "nav", "ol", "p", "pre", "search", "section", "summary", "table", "ul",
])

const NOT_RENDERED_TAGS: ReadonlySet<string> = new Set(["head", "noscript", "script", "style", "template", "title"])

const PREFORMATTED_TAGS: ReadonlySet<string> = new Set(["listing", "plaintext", "pre", "textarea", "xmp"])

const PREFORMATTED_STYLE = /(?:^|;)\s*white-space\s*:\s*(?:pre|pre-wrap|break-spaces)\b/i
const HIDDEN_STYLE = /(?:^|;)\s*display\s*:\s*none\b/i

function isNotRendered(element: Element): boolean {
  if (NOT_RENDERED_TAGS.has(element.localName) || element.getAttribute("hidden") !== null) return true
  const style = element.getAttribute("style")
  return style !== null && HIDDEN_STYLE.test(style)
}

function isPreformatted(element: Element): boolean {
  if (PREFORMATTED_TAGS.has(element.localName)) return true
  const style = element.getAttribute("style")
  return style !== null && PREFORMATTED_STYLE.test(style)
}

function isTableCell(element: Element): boolean {
  return element.localName === "td" || element.localName === "th"
}

function hasNextCell(element: Element): boolean {
  for (let sibling = element.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
    if (isTableCell(sibling) && !isNotRendered(sibling)) return true
  }
  return false
}

class Collector {
  private text = ""
  private pendingBreaks = 0
  /** The text ends in a collapsible space, which goes at the end of a line. */
  private trailingSpace = false

  requireBreaks(count: number): void {
    this.pendingBreaks = Math.max(this.pendingBreaks, count)
  }

  add(text: string, collapsible: boolean): void {
    let appended = text
    if (collapsible) {
      appended = appended.replace(/[ \t\n\r\f]+/g, " ")
      const atLineStart = this.text === "" || this.pendingBreaks > 0 || this.trailingSpace || this.text.endsWith("\n")
      if (atLineStart && appended.startsWith(" ")) appended = appended.slice(1)
    }
    if (appended === "") return
    this.flushBreaks()
    if (appended.startsWith("\n")) this.dropTrailingSpace()
    this.text += appended
    this.trailingSpace = collapsible && appended.endsWith(" ")
  }

  result(): string {
    this.dropTrailingSpace()
    return this.text
  }

  private dropTrailingSpace(): void {
    if (!this.trailingSpace) return
    this.text = this.text.slice(0, -1)
    this.trailingSpace = false
  }

  private flushBreaks(): void {
    if (this.pendingBreaks === 0) return
    if (this.text !== "") {
      this.dropTrailingSpace()
      this.text += "\n".repeat(this.pendingBreaks)
    }
    this.pendingBreaks = 0
  }
}

function inPreformatted(node: Node): boolean {
  for (let current: Node | null = node; current !== null; current = current.parentNode) {
    if (current.nodeType === ELEMENT_NODE && isPreformatted(current as Element)) return true
  }
  return false
}

function collect(node: Node, range: Range | null, preformatted: boolean, into: Collector): void {
  if (node.nodeType === TEXT_NODE) {
    const data = (node as unknown as { data: string }).data
    const start = range !== null && node === range.startContainer ? range.startOffset : 0
    const end = range !== null && node === range.endContainer ? range.endOffset : data.length
    into.add(data.slice(start, end), !preformatted)
    return
  }
  if (node.nodeType !== ELEMENT_NODE) return
  const element = node as Element
  if (isNotRendered(element)) return
  const tag = element.localName
  if (tag === "br") {
    into.add("\n", false)
    return
  }
  const block = BLOCK_TAGS.has(tag)
  const breaks = tag === "p" ? 2 : 1
  if (block) into.requireBreaks(breaks)
  const keepsSpaces = preformatted || isPreformatted(element)
  for (const child of element.childNodes) {
    if (range !== null && !range.intersectsNode(child)) continue
    collect(child, range, keepsSpaces, into)
  }
  if (block) into.requireBreaks(breaks)
  if (isTableCell(element) && hasNextCell(element)) into.add("\t", false)
  if (tag === "tr") into.requireBreaks(1)
}

/** `element.innerText`: the text of an element that is not rendered is its `textContent`. */
export function innerTextOf(element: Element): string {
  if (isNotRendered(element)) return element.textContent ?? ""
  const into = new Collector()
  collect(element, null, inPreformatted(element), into)
  return into.result()
}

/** The text of `range` as a browser copies it: `innerText` over the nodes the range holds, its ends clipped. */
export function rangeInnerText(range: Range): string {
  const into = new Collector()
  const root = range.commonAncestorContainer
  collect(root, range, inPreformatted(root), into)
  return into.result()
}

function setInnerText(element: Element, value: unknown): void {
  const text = value === null ? "" : String(value)
  const binding = element[DOM_BINDING]() as ParentBinding
  const fragment = binding.createFragment()
  const into = fragment[DOM_BINDING]() as ParentBinding
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) into.insertBefore(binding.createElement("br"), null)
    if (line !== "") into.insertBefore(binding.createText(line), null)
  })
  element.replaceChildren(fragment)
}

/** Defines `innerText` on `prototype`, the one of `Element`. */
export function defineInnerTextMember(prototype: object): void {
  Object.defineProperty(prototype, "innerText", {
    configurable: true,
    get(this: Element) {
      return innerTextOf(this)
    },
    set(this: Element, value: unknown) {
      setInnerText(this, value)
    },
  })
}
