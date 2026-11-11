/** The HTML tags that are host elements. Each lays out as a `div` or a `span` does, with the default style of
 *  Chrome's user agent stylesheet: `packages/native/src/html/tags.rs` is the one table of those styles, and this
 *  list is the same set. `code` and `select` are not here: Ghia has elements of those names. */
export const HTML_TAGS = [
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
