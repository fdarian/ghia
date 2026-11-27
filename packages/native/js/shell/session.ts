import { namedError } from "../named-error.js"
import { dispatchWindowEvent } from "./window-events.js"

/** An http origin, so that `new URL(link.href).origin === location.origin` holds for a link a router builds. */
export const INITIAL_HREF = "http://localhost/"

/**
 * `stored` is the structured clone `pushState` made and is never handed out; `live` is the copy `history.state` and the
 * popstate event show, made on first read and again whenever a traversal arrives at the entry, as a browser deserializes it.
 */
interface Entry {
  readonly url: URL
  readonly stored: unknown
  live: { readonly value: unknown } | undefined
}

function entryOf(url: URL, stored: unknown): Entry {
  return { url, stored, live: undefined }
}

function liveState(entry: Entry): unknown {
  entry.live ??= { value: structuredClone(entry.stored) }
  return entry.live.value
}

function fragmentOf(url: URL): string | null {
  const start = url.href.indexOf("#")
  return start < 0 ? null : url.href.slice(start + 1)
}

function withoutFragment(url: URL): string {
  const start = url.href.indexOf("#")
  return start < 0 ? url.href : url.href.slice(0, start)
}

function queueTask(task: () => void): void {
  setTimeout(task, 0)
}

/**
 * The session history of the one document a Ghia app has: a list of entries and the index of the current one.
 * Nothing leaves the process, so it lives as long as the app does.
 */
class SessionHistory {
  private entries: Entry[] = [entryOf(new URL(INITIAL_HREF), null)]
  private index = 0
  scrollRestoration: "auto" | "manual" = "auto"

  get length(): number {
    return this.entries.length
  }

  get state(): unknown {
    return liveState(this.current)
  }

  /** Read-only: a caller that changes a URL copies it first. */
  get url(): URL {
    return this.current.url
  }

  private get current(): Entry {
    return this.entries[this.index]
  }

  /** `state` is already a structured clone that nothing else holds. */
  pushState(state: unknown, url: URL): void {
    this.entries.splice(this.index + 1, this.entries.length, entryOf(url, state))
    this.index += 1
  }

  replaceState(state: unknown, url: URL): void {
    this.entries[this.index] = entryOf(url, state)
  }

  /**
   * Whether `target` is a navigation Ghia can do: one that changes the fragment of the current URL and nothing else.
   * A URL with an empty fragment counts, and one equal to the current URL with a fragment is a navigation too, as in a browser.
   */
  isFragmentNavigation(target: URL): boolean {
    return fragmentOf(target) !== null && withoutFragment(target) === withoutFragment(this.current.url)
  }

  /** Navigates to a URL that differs from the current one in its fragment only: a new entry, or the current one replaced. */
  navigateToFragment(target: URL, replace: boolean): void {
    const from = this.current.url
    if (replace || target.href === from.href) this.replaceState(null, target)
    else this.pushState(null, target)
    // popstate is synchronous, even to the current URL; only hashchange is a task, and only when the fragment changed.
    dispatchWindowEvent("popstate", { state: this.state })
    if (fragmentOf(from) === fragmentOf(target)) return
    queueTask(() => dispatchWindowEvent("hashchange", { oldURL: from.href, newURL: target.href }))
  }

  /** `delta` is read when the task runs, as a browser reads it when the traversal's turn comes, so `back()` twice goes back two entries. */
  go(delta: number): void {
    if (delta === 0) return
    queueTask(() => this.traverse(delta))
  }

  private traverse(delta: number): void {
    const target = this.index + delta
    if (target < 0 || target >= this.entries.length) return
    const from = this.current.url
    this.index = target
    const to = this.current
    to.live = undefined
    dispatchWindowEvent("popstate", { state: liveState(to) })
    if (fragmentOf(from) !== fragmentOf(to.url)) {
      dispatchWindowEvent("hashchange", { oldURL: from.href, newURL: to.url.href })
    }
  }
}

export const session = new SessionHistory()

/** The error a navigation that would load another document throws: Ghia has one document and no way to replace it. */
export function noDocumentNavigation(what: string): Error {
  return namedError(
    "NotSupportedError",
    `${what}: Ghia has no document navigation. To change the URL without loading a page, use history.pushState or history.replaceState.`
  )
}
