import { namedError } from "../named-error.js"
import { session } from "./session.js"

const CONSTRUCT = Symbol("History")

function methodError(method: string, message: string): string {
  return `Failed to execute '${method}' on 'History': ${message}`
}

function sameOriginUrl(method: string, url: string | URL | null | undefined): URL {
  if (url === undefined || url === null) return session.url
  const text = String(url)
  let resolved: URL
  try {
    resolved = new URL(text, session.url)
  } catch {
    throw namedError("SecurityError", methodError(method, `A history state object with URL '${text}' cannot be created in a document with origin '${session.url.origin}' and URL '${session.url.href}'.`))
  }
  if (resolved.origin !== session.url.origin) {
    throw namedError("SecurityError", methodError(method, `A history state object with URL '${resolved.href}' cannot be created in a document with origin '${session.url.origin}' and URL '${session.url.href}'.`))
  }
  return resolved
}

/** The session history of the app's one document, in memory. `go(0)` does nothing, where a browser reloads. */
export class History {
  constructor(token?: symbol) {
    if (token !== CONSTRUCT) throw new TypeError("Illegal constructor")
  }

  get length(): number {
    return session.length
  }

  get state(): unknown {
    return session.state
  }

  get scrollRestoration(): "auto" | "manual" {
    return session.scrollRestoration
  }

  set scrollRestoration(value: "auto" | "manual") {
    if (value === "auto" || value === "manual") session.scrollRestoration = value
  }

  pushState(state: unknown, _unused: string, url?: string | URL | null): void {
    const cloned = structuredClone(state)
    session.pushState(cloned, sameOriginUrl("pushState", url))
  }

  replaceState(state: unknown, _unused: string, url?: string | URL | null): void {
    const cloned = structuredClone(state)
    session.replaceState(cloned, sameOriginUrl("replaceState", url))
  }

  go(delta?: number): void {
    const steps = Math.trunc(Number(delta))
    session.go(Number.isNaN(steps) ? 0 : steps)
  }

  back(): void {
    session.go(-1)
  }

  forward(): void {
    session.go(1)
  }
}

export const history = new History(CONSTRUCT)
