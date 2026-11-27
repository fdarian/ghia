import { window as ghiaWindowTarget } from "../events/window-target.js"
import { history, History } from "./history.js"
import { location, Location } from "./location.js"
import { getLocalStorage, getSessionStorage, Storage } from "./storage.js"

type Handler = ((event: Event) => unknown) | null

/** `onpopstate` and `onhashchange`: one listener on the window target, made when the first handler is set, calls the current handler. */
function defineEventHandler(type: string): void {
  let handler: Handler = null
  let listening = false
  Object.defineProperty(globalThis, `on${type}`, {
    configurable: true,
    get: () => handler,
    set: (value: unknown) => {
      handler = typeof value === "function" ? (value as Handler) : null
      if (handler === null || listening) return
      listening = true
      ghiaWindowTarget.addEventListener(type, (event) => {
        if (handler !== null) handler.call(globalThis, event as unknown as Event)
      })
    },
  })
}

/**
 * Installs `location`, `history`, `localStorage` and `sessionStorage` on the global object, which is `window`.
 * `localStorage` is made on first read, because it needs the app id the plugin sets before the app's modules run.
 */
export function installShell(): void {
  // The classes replace a runtime's own (Node 25 has a `Storage`), so `location instanceof Location` holds.
  Object.defineProperties(globalThis, {
    Location: { value: Location, configurable: true, writable: true },
    History: { value: History, configurable: true, writable: true },
    Storage: { value: Storage, configurable: true, writable: true },
    location: {
      configurable: true,
      enumerable: true,
      get: () => location,
      set: (value: unknown) => {
        location.href = String(value)
      },
    },
    history: { value: history, configurable: true, writable: true, enumerable: true },
    localStorage: { configurable: true, enumerable: true, get: getLocalStorage },
    sessionStorage: { configurable: true, enumerable: true, get: getSessionStorage },
  })
  defineEventHandler("popstate")
  defineEventHandler("hashchange")
}
