/** The HTML tags that are host elements. Each lays out as a `div` or a `span` does, with the default style of
 *  Chrome's user agent stylesheet: `packages/native/src/html/tags.rs` is the one table of those styles, and this
 *  list is the same set. `code` and `select` are not here: Ghia has elements of those names. */
export const HTML_TAGS = [
  "html", "head", "body",
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd",
  "section", "nav", "header", "footer", "main", "article", "aside",
  "figure", "figcaption", "blockquote", "pre", "fieldset", "legend", "address", "hr", "details", "summary", "dialog",
  "a", "strong", "em", "b", "i", "u", "s", "small", "mark", "abbr", "cite", "q", "sub", "sup", "time", "kbd", "var", "samp", "br", "wbr",
  "button",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
] as const

export type HtmlTag = (typeof HTML_TAGS)[number]

const HTML_TAG_SET: ReadonlySet<string> = new Set(HTML_TAGS)

export function isHtmlTag(type: string): type is HtmlTag {
  return HTML_TAG_SET.has(type)
}

/** The tags that are inline unless a style says otherwise, as a `span` is: the rows of the native table whose
 *  `display` is `inline`. */
export const HTML_INLINE_TAGS = [
  "a", "strong", "em", "b", "i", "u", "s", "small", "mark", "abbr", "cite", "q", "sub", "sup", "time", "kbd", "var", "samp", "br", "wbr",
] as const satisfies readonly HtmlTag[]

const HTML_INLINE_TAG_SET: ReadonlySet<string> = new Set(HTML_INLINE_TAGS)

export function isInlineHtmlTag(type: string): boolean {
  return HTML_INLINE_TAG_SET.has(type)
}

/** The hosts that lay out as a `div` or a `span` does: the inline ones among them are the inline boxes of a paragraph. */
const BOX_HOSTS: ReadonlySet<string> = new Set(["div", "span", "html", "head", "body"])

/**
 * Whether an element of `type` with `style` is an inline box of the paragraph around it, which only shows what a
 * span shows (`assertSpanMotionValues`). The effective `display` decides, never the tag: an `<a>` with
 * `display: block` is a block and a `<div>` with `display: inline` is an inline box. The tag only gives the
 * `display` a style leaves out. Mirrors `text::inline::is_inline_wrapper`: a `button` is an atomic inline whatever
 * its `display` says, and a box positioned `absolute` or `fixed` is blockified.
 */
export function isInlineBox(type: string, style: { display?: unknown; position?: unknown } | undefined): boolean {
  if (!BOX_HOSTS.has(type) && !isHtmlTag(type)) return false
  if (type === "button") return false
  if (style?.position === "absolute" || style?.position === "fixed") return false
  if (style?.display !== undefined) return style.display === "inline"
  return type === "span" || isInlineHtmlTag(type)
}

/** What a tag forwards to native beyond the props of every host element. */
export const HTML_TAG_PROPS: Readonly<Partial<Record<HtmlTag, readonly string[]>>> = {
  a: ["href"],
  button: ["type", "disabled"],
}

export interface HtmlAnchorProps {
  href?: string
}

export interface HtmlButtonProps {
  type?: "button" | "submit" | "reset"
  disabled?: boolean
}
