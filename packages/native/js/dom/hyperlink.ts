/**
 * The members of `<a>` and `<area>` that the HTML standard calls HTMLHyperlinkElementUtils (`href`,
 * `origin`, `protocol`, `username`, `password`, `host`, `hostname`, `port`, `pathname`, `search`,
 * `hash`) and the attributes they reflect (`target`, `download`, `rel`, `relList`, `referrerPolicy`,
 * and on `<a>` `hreflang` and `text`). The URL is the `href` attribute resolved against the
 * document's URL, which is `location.href`; the setters change that URL and write it back to `href`.
 * A router reads `a.href` and compares its origin to `location.origin`, so this is what a link
 * has to answer for it to take the click.
 */

import { relListOf, type DOMTokenList } from "./class-list.js"
import type { Element } from "./nodes.js"
import { onTags } from "./tag-members.js"

const LINK_TAGS: ReadonlySet<string> = new Set(["a", "area"])
const ANCHOR_TAG: ReadonlySet<string> = new Set(["a"])

const REFERRER_POLICIES: ReadonlySet<string> = new Set([
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
])

/** The members as the DOM types them; on any tag but `<a>` and `<area>` they are `undefined`. */
export interface HyperlinkMembers {
  /** The `href` attribute resolved against `location.href`; the attribute as written when that is not a URL, `""` without one. Assigning sets the attribute. */
  href: string
  readonly origin: string
  protocol: string
  username: string
  password: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
  target: string
  download: string
  rel: string
  /** The tokens of `rel` as a live list; assigning sets `rel`. */
  relList: DOMTokenList
  /** `<a>` only. */
  hreflang: string
  /** `<a>` only: the element's text content. */
  text: string
  /** The `referrerpolicy` attribute limited to its keywords, `""` for any other text. */
  referrerPolicy: string
}

/**
 * The URL of the link: its `href` resolved against the document, `null` for no attribute or text that is not a URL. Reads the global `location` rather than the session: `nodes.ts` loads this module and the session reaches `nodes.ts` back. */
export function linkUrl(element: Element): URL | null {
  const href = element.getAttribute("href")
  if (href === null) return null
  try {
    return new URL(href, location.href)
  } catch {
    return null
  }
}

function writeUrlThrough(element: Element, change: (url: URL) => void): void {
  const url = linkUrl(element)
  if (url === null) return
  change(url)
  element.setAttribute("href", url.href)
}

/** A member that is a part of the URL: `""` when the link has none, and a setter that changes that part and rewrites `href`. */
function urlPart(name: string, read: (url: URL) => string, write?: (url: URL, value: string) => void) {
  return onTags<Element>(
    name,
    LINK_TAGS,
    (element) => {
      const url = linkUrl(element)
      return url === null ? "" : read(url)
    },
    (element, value) => {
      if (write === undefined) return
      writeUrlThrough(element, (url) => write(url, String(value)))
    }
  )
}

function stringAttribute(name: string, attribute: string, tags: ReadonlySet<string>) {
  return onTags<Element>(
    name,
    tags,
    (element) => element.getAttribute(attribute) ?? "",
    (element, value) => element.setAttribute(attribute, String(value))
  )
}

/** Defines the members on `target`, the prototype of `Element`; on any other tag than `<a>` and `<area>` they read `undefined`. */
export function defineHyperlinkMembers(target: object): void {
  Object.defineProperties(target, {
    href: onTags<Element>(
      "href",
      LINK_TAGS,
      (element) => {
        const url = linkUrl(element)
        // Text that is no URL reads back as written, as in a browser.
        return url === null ? (element.getAttribute("href") ?? "") : url.href
      },
      (element, value) => element.setAttribute("href", String(value))
    ),
    origin: urlPart("origin", (url) => url.origin),
    protocol: onTags<Element>(
      "protocol",
      LINK_TAGS,
      (element) => linkUrl(element)?.protocol ?? ":",
      (element, value) =>
        writeUrlThrough(element, (url) => {
          url.protocol = String(value)
        })
    ),
    username: urlPart("username", (url) => url.username, (url, value) => (url.username = value)),
    password: urlPart("password", (url) => url.password, (url, value) => (url.password = value)),
    host: urlPart("host", (url) => url.host, (url, value) => (url.host = value)),
    hostname: urlPart("hostname", (url) => url.hostname, (url, value) => (url.hostname = value)),
    port: urlPart("port", (url) => url.port, (url, value) => (url.port = value)),
    pathname: urlPart("pathname", (url) => url.pathname, (url, value) => (url.pathname = value)),
    search: urlPart("search", (url) => url.search, (url, value) => (url.search = value)),
    hash: urlPart("hash", (url) => url.hash, (url, value) => (url.hash = value)),
    target: stringAttribute("target", "target", LINK_TAGS),
    download: stringAttribute("download", "download", LINK_TAGS),
    rel: stringAttribute("rel", "rel", LINK_TAGS),
    hreflang: stringAttribute("hreflang", "hreflang", ANCHOR_TAG),
    relList: onTags<Element>(
      "relList",
      LINK_TAGS,
      (element) => relListOf(element),
      (element, value) => element.setAttribute("rel", String(value))
    ),
    text: onTags<Element>(
      "text",
      ANCHOR_TAG,
      (element) => element.textContent ?? "",
      (element, value) => {
        element.textContent = String(value)
      }
    ),
    referrerPolicy: onTags<Element>(
      "referrerPolicy",
      LINK_TAGS,
      (element) => {
        const keyword = (element.getAttribute("referrerpolicy") ?? "").toLowerCase()
        return REFERRER_POLICIES.has(keyword) ? keyword : ""
      },
      (element, value) => element.setAttribute("referrerpolicy", String(value))
    ),
  })
}
