import { getComputedStyle } from "./computed-style.js"
import { createDomEvent, EVENT_PHASE_AT_TARGET, EVENT_PHASE_NONE, reportHandlerErrors } from "./events/dispatch.js"
import type { GpuixEventTarget } from "./events/event-target.js"
import { globalWindow } from "./events/window-target.js"
import { installWindowHooks, type GpuixWindow } from "./events/window-targets.js"
import type { NativeRenderer } from "./host.js"
import { matchMediaFor } from "./match-media.js"
import { createRendererState } from "./renderer-state.js"

const NO_ROOT = { eventHandlers: new Map(), elementById: () => undefined }

type WindowSize = { width: number; height: number }

/** Runs the `resize` listeners of `listeners` with `target` as the event's target. */
function sendResize(listeners: GpuixEventTarget, target: object): void {
  const created = createDomEvent(NO_ROOT, { elementId: 0, eventType: "resize" }, [], target)
  const event = created.event
  const state = created.state
  const errors: unknown[] = []
  listeners.run(event, state, true, EVENT_PHASE_AT_TARGET, (error) => errors.push(error))
  listeners.run(event, state, false, EVENT_PHASE_AT_TARGET, (error) => errors.push(error))
  event.currentTarget = null
  event.eventPhase = EVENT_PHASE_NONE
  reportHandlerErrors(NO_ROOT, errors)
}

/** The renderer each window is watched through, with the size last seen, while it has a `resize` listener and a root. */
const watched = new WeakMap<GpuixWindow, { renderer: NativeRenderer; size: WindowSize; stop: () => void }>()

function onMediaChange(window: GpuixWindow, renderer: NativeRenderer): void {
  const watch = watched.get(window)
  if (watch === undefined || watch.renderer !== renderer) return
  const size = window.size("resize")
  const last = watch.size
  watch.size = size
  if (last.width === size.width && last.height === size.height) return
  // The visual viewport goes first: it is the one whose size a library measures a keyboard or a zoom by.
  sendResize(window.visualViewport.listeners, window.visualViewport)
  syncResize(window)
  sendResize(window.events, window.view)
  syncResize(window)
}

function syncResize(window: GpuixWindow): void {
  const mounted = window.renderer
  const wanted =
    window.listensForResize && window.isMounted && mounted?.getWindowSize !== undefined ? mounted : undefined
  const current = watched.get(window)
  if (current?.renderer === wanted) return
  current?.stop()
  watched.delete(window)
  if (wanted === undefined) return
  watched.set(window, {
    renderer: wanted,
    size: window.size("resize"),
    stop: createRendererState(wanted).subscribeMedia(() => onMediaChange(window, wanted)),
  })
}

/**
 * Installs the members of `window` a library reads for the size of the screen it draws on, and the
 * members that follow the window: they answer for the global window, the first one that mounted.
 * Another window's own members are on its window target (`windowOf(renderer)`), which is also
 * where the `resize` event of every window is sent.
 */
export function installWindowMembers(): void {
  installWindowHooks({
    syncResize,
    matchMedia: (renderer, query) => matchMediaFor(renderer)(query),
    getComputedStyle,
  })
  Object.defineProperties(globalThis, {
    innerWidth: {
      configurable: true,
      get: () => globalWindow().innerWidth,
    },
    innerHeight: {
      configurable: true,
      get: () => globalWindow().innerHeight,
    },
    // The document cannot scroll (Ghia has no scrolling element for the viewport), so the window is always at its origin.
    scrollX: { value: 0, configurable: true, writable: true },
    scrollY: { value: 0, configurable: true, writable: true },
    visualViewport: { configurable: true, get: () => globalWindow().visualViewport },
    frameElement: { value: null, configurable: true, writable: true },
  })
  // A runtime that has its own keeps it: `self` is the global object already in Bun.
  for (const name of ["parent", "top", "self"]) {
    if (Reflect.get(globalThis, name) !== undefined) continue
    Object.defineProperty(globalThis, name, { value: globalThis, configurable: true, writable: true })
  }
}
