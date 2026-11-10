import { createDomEvent, EVENT_PHASE_AT_TARGET, EVENT_PHASE_NONE, reportHandlerErrors } from "./events/dispatch.js"
import { GpuixEventTarget } from "./events/window-target.js"
import type { AddEventListenerOptions, WindowEventListener } from "./events/window-target.js"
import { mountedRenderer } from "./mounted-renderer.js"
import { createRendererState } from "./renderer-state.js"
import type { NativeRenderer } from "./host.js"

type WindowSize = { width: number; height: number }

/** The window every member below reads is the one that mounted last, as for `matchMedia` and `document.body`. */
function currentRenderer(member: string): NativeRenderer {
  const renderer = mountedRenderer()
  if (renderer === undefined) {
    throw new Error(`${member} needs a mounted GPUIX root. Read it after render().`)
  }
  return renderer
}

function currentWindowSize(member: string): WindowSize {
  const renderer = currentRenderer(member)
  if (renderer.getWindowSize === undefined) {
    throw new Error(`This renderer does not report the window size, so ${member} cannot be read`)
  }
  return renderer.getWindowSize()
}

const NO_ROOT = { eventHandlers: new Map(), elementById: () => undefined }

/**
 * The window's visual viewport. Ghia has no pinch zoom or on-screen keyboard that moves it, so
 * it is the window's content box at scale 1, and the document cannot scroll.
 */
class VisualViewport {
  private readonly listeners = new GpuixEventTarget()
  private stopWatching: (() => void) | undefined
  private lastSize: WindowSize | undefined

  readonly offsetLeft = 0
  readonly offsetTop = 0
  readonly pageLeft = 0
  readonly pageTop = 0
  readonly scale = 1

  get width(): number {
    return currentWindowSize("visualViewport.width").width
  }

  get height(): number {
    return currentWindowSize("visualViewport.height").height
  }

  addEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | AddEventListenerOptions
  ): void {
    // Subscribed first, so a window that cannot be watched leaves no listener behind.
    if (type.toLowerCase() === "resize" && this.stopWatching === undefined) this.startWatching()
    this.listeners.addEventListener(type, listener, options)
  }

  removeEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | Pick<AddEventListenerOptions, "capture">
  ): void {
    this.listeners.removeEventListener(type, listener, options)
    this.stopWatchingIfIdle()
  }

  /**
   * A window's size changes arrive as its `mediaChange` event, which also carries OS
   * preference changes, so a `resize` is sent only when the size is not the one last seen.
   */
  private startWatching(): void {
    const renderer = currentRenderer("visualViewport.addEventListener")
    this.lastSize = currentWindowSize("visualViewport.addEventListener")
    this.stopWatching = createRendererState(renderer).subscribeMedia(() => this.onMediaChange())
  }

  private stopWatchingIfIdle(): void {
    if (this.stopWatching === undefined || this.listeners.hasListeners("resize")) return
    this.stopWatching()
    this.stopWatching = undefined
    this.lastSize = undefined
  }

  private onMediaChange(): void {
    const size = currentWindowSize("visualViewport")
    const last = this.lastSize
    this.lastSize = size
    if (last !== undefined && last.width === size.width && last.height === size.height) return
    const { event, state } = createDomEvent(NO_ROOT, { elementId: 0, eventType: "resize" }, [], this)
    const errors: unknown[] = []
    this.listeners.run(event, state, true, EVENT_PHASE_AT_TARGET, (error) => errors.push(error))
    this.listeners.run(event, state, false, EVENT_PHASE_AT_TARGET, (error) => errors.push(error))
    event.currentTarget = null
    event.eventPhase = EVENT_PHASE_NONE
    this.stopWatchingIfIdle()
    reportHandlerErrors(NO_ROOT, errors)
  }
}

const visualViewport = new VisualViewport()

/** Installs the members of `window` a library reads for the size of the screen it draws on. */
export function installWindowMembers(): void {
  Object.defineProperties(globalThis, {
    innerWidth: {
      configurable: true,
      get: () => currentWindowSize("innerWidth").width,
    },
    innerHeight: {
      configurable: true,
      get: () => currentWindowSize("innerHeight").height,
    },
    visualViewport: { value: visualViewport, configurable: true, writable: true },
    frameElement: { value: null, configurable: true, writable: true },
  })
  // A runtime that has its own keeps it: `self` is the global object already in Bun.
  for (const name of ["parent", "top", "self"]) {
    if (Reflect.get(globalThis, name) !== undefined) continue
    Object.defineProperty(globalThis, name, { value: globalThis, configurable: true, writable: true })
  }
}
