import { namedError } from "../named-error.js"
import { opensInSystem, openLinkExternally } from "./open-link.js"
import { noDocumentNavigation, session } from "./session.js"

const CONSTRUCT = Symbol("Location")

function resolve(url: string): URL {
  try {
    return new URL(url, session.url)
  } catch {
    throw namedError("SyntaxError", `Failed to parse '${url}' as a URL relative to '${session.url.href}'.`)
  }
}

function navigate(target: URL, replace: boolean): void {
  if (session.isFragmentNavigation(target)) {
    session.navigateToFragment(target, replace)
    return
  }
  // The same hand-off as a click on a link to another origin; the document stays where it is.
  if (opensInSystem(target)) {
    openLinkExternally(target)
    return
  }
  throw noDocumentNavigation(`Cannot navigate to '${target.href}'`)
}

function navigateWith(change: (copy: URL) => void): void {
  const copy = new URL(session.url.href)
  change(copy)
  navigate(copy, false)
}

/**
 * The location of the app's one document: `http://localhost/` until `history.pushState` moves it. A navigation that changes
 * the fragment only is a fragment navigation, as in a browser; a link to another origin that the system can open (`http:`,
 * `https:`, `mailto:`, `tel:`) is handed to it, and any other one would load a document, which Ghia has not.
 */
export class Location {
  constructor(token?: symbol) {
    if (token !== CONSTRUCT) throw new TypeError("Illegal constructor")
  }

  get href(): string {
    return session.url.href
  }

  set href(value: string) {
    navigate(resolve(String(value)), false)
  }

  get origin(): string {
    return session.url.origin
  }

  get protocol(): string {
    return session.url.protocol
  }

  set protocol(value: string) {
    navigateWith((copy) => (copy.protocol = String(value)))
  }

  get host(): string {
    return session.url.host
  }

  set host(value: string) {
    navigateWith((copy) => (copy.host = String(value)))
  }

  get hostname(): string {
    return session.url.hostname
  }

  set hostname(value: string) {
    navigateWith((copy) => (copy.hostname = String(value)))
  }

  get port(): string {
    return session.url.port
  }

  set port(value: string) {
    navigateWith((copy) => (copy.port = String(value)))
  }

  get pathname(): string {
    return session.url.pathname
  }

  set pathname(value: string) {
    navigateWith((copy) => (copy.pathname = String(value)))
  }

  get search(): string {
    return session.url.search
  }

  set search(value: string) {
    navigateWith((copy) => (copy.search = String(value)))
  }

  get hash(): string {
    return session.url.hash
  }

  set hash(value: string) {
    const input = String(value).replace(/^#/, "")
    const current = session.url.href
    const start = current.indexOf("#")
    // `URL.hash = ""` removes the fragment, while this setter leaves an empty one (`http://localhost/#`).
    const target = new URL(`${start < 0 ? current : current.slice(0, start)}#${input}`)
    // The same fragment is no navigation: no entry, no event, and `history.state` stays.
    if (target.href === current) return
    navigate(target, false)
  }

  assign(url: string): void {
    navigate(resolve(String(url)), false)
  }

  replace(url: string): void {
    navigate(resolve(String(url)), true)
  }

  reload(): never {
    throw noDocumentNavigation("location.reload()")
  }

  toString(): string {
    return session.url.href
  }
}

export const location = new Location(CONSTRUCT)
