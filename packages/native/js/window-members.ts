import { createDomEvent, EVENT_PHASE_AT_TARGET, EVENT_PHASE_NONE, reportHandlerErrors } from "./events/dispatch.js"
import { GpuixEventTarget, subscribeWindowEventTypes, window as ghiaWindow } from "./events/window-target.js"
import type { AddEventListenerOptions, WindowEventListener } from "./events/window-target.js"
import { mountedRenderer, subscribeMountedRenderer } from "./mounted-renderer.js"
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

function windowSizeOf(renderer: NativeRenderer, member: string): WindowSize {
  if (renderer.getWindowSize === undefined) {
    throw new Error(`This renderer does not report the window size, so ${member} cannot be read`)
  }
  return renderer.getWindowSize()
}

function currentWindowSize(member: string): WindowSize {
  return windowSizeOf(currentRenderer(member), member)
}

const NO_ROOT = { eventHandlers: new Map(), elementById: () => undefined }

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

/**
 * Sends `resize` to `visualViewport` and `window` when the size of the window that mounted last
 * changes. A window's size changes arrive as its `mediaChange` event, which also carries OS
 * preference changes, so the event goes out only when the size is not the one last seen. One
 * subscription serves both targets, and it exists only while one of them has a `resize` listener
 * and a root is mounted; it follows the mounted window when that changes.
 */
class ResizeWatch {
  private watched:
    | { renderer: NativeRenderer; size: WindowSize; stop: () => void }
    | undefined

  constructor(
    private readonly listening: () => boolean,
    private readonly targets: () => Array<[GpuixEventTarget, object]>
  ) {}

  /** Follows the listeners and the mounted window: call it when either may have changed. */
  sync(): void {
    const mounted = mountedRenderer()
    const wanted =
      this.listening() && mounted !== undefined && mounted.getWindowSize !== undefined ? mounted : undefined
    if (this.watched?.renderer === wanted) return
    this.watched?.stop()
    this.watched = undefined
    if (wanted === undefined) return
    const renderer = wanted
    this.watched = {
      renderer,
      size: windowSizeOf(renderer, "resize"),
      stop: createRendererState(renderer).subscribeMedia(() => this.onMediaChange(renderer)),
    }
  }

  private onMediaChange(renderer: NativeRenderer): void {
    const watched = this.watched
    if (watched === undefined || watched.renderer !== renderer) return
    const size = windowSizeOf(renderer, "resize")
    const last = watched.size
    watched.size = size
    if (last.width === size.width && last.height === size.height) return
    // The visual viewport goes first: it is the one whose size a library measures a keyboard or a zoom by.
    for (const [listeners, target] of this.targets()) {
      sendResize(listeners, target)
      this.sync()
    }
  }
}

/**
 * The window's visual viewport. Ghia has no pinch zoom or on-screen keyboard that moves it, so
 * it is the window's content box at scale 1, and the document cannot scroll.
 */
class VisualViewport {
  readonly listeners = new GpuixEventTarget(undefined, this)

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
    this.listeners.addEventListener(type, listener, options)
    resizeWatch.sync()
  }

  removeEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | Pick<AddEventListenerOptions, "capture">
  ): void {
    this.listeners.removeEventListener(type, listener, options)
    resizeWatch.sync()
  }
}

const visualViewport = new VisualViewport()
const resizeWatch = new ResizeWatch(
  () => visualViewport.listeners.hasListeners("resize") || ghiaWindow.hasListeners("resize"),
  () => [
    [visualViewport.listeners, visualViewport],
    [ghiaWindow, globalThis],
  ]
)

/**
 * Installs the members of `window` a library reads for the size of the screen it draws on, and
 * the `resize` event of `window` and `visualViewport`.
 */
export function installWindowMembers(): void {
  subscribeWindowEventTypes(() => resizeWatch.sync())
  subscribeMountedRenderer(() => resizeWatch.sync())
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
