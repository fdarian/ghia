import { FrameList } from "../animation-frame.js"
import type { getComputedStyle } from "../computed-style.js"
import type { NativeRenderer } from "../host.js"
import type { MediaQueryList } from "../match-media.js"
import { GpuixEventTarget, type AddEventListenerOptions, type WindowEventListener } from "./event-target.js"
import type { GpuixDocument } from "./window-target.js"

/**
 * What a window needs of modules that load it: they register it from `window-members.ts`, so this
 * module has no import that leads back to the renderer state and the DOM classes.
 */
type WindowHooks = {
  /** Follows the `resize` listeners and the renderer of `window`: see `GpuixWindow.syncResize`. */
  syncResize(window: GpuixWindow): void
  matchMedia(renderer: NativeRenderer, query: string): MediaQueryList
  getComputedStyle: typeof getComputedStyle
}

let installedHooks: WindowHooks | undefined

/** @internal Called once by `window-members.ts`. */
export function installWindowHooks(hooks: WindowHooks): void {
  installedHooks = hooks
}

function hooks(): WindowHooks {
  if (installedHooks === undefined) {
    throw new Error("The window members are not installed: import @ghia/native/host before using a window's matchMedia or getComputedStyle")
  }
  return installedHooks
}

type WindowSize = { width: number; height: number }

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

  constructor(private readonly window: GpuixWindow) {}

  get width(): number {
    return this.window.size("visualViewport.width").width
  }

  get height(): number {
    return this.window.size("visualViewport.height").height
  }

  addEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.listeners.addEventListener(type, listener, options)
    this.window.syncResize()
  }

  removeEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | Pick<AddEventListenerOptions, "capture">
  ): void {
    this.listeners.removeEventListener(type, listener, options)
    this.window.syncResize()
  }
}

/** What a window needs of the runtime around it: the renderer it draws in and the object it presents itself as. */
export type WindowLinks = {
  /** Called when a type gains its first listener or loses its last on the window target. */
  onTypesChange: () => void
  /** What `event.currentTarget` is while the window's own listeners run: the global object for the first window, else the window target. */
  owner?: object
  /** Whether the window has a root mounted and is open: what its size, `matchMedia` and the reads of native need. */
  mounted: () => boolean
}

/**
 * The target at the top of one window's event path, and the members of `window` that belong to one
 * window: its size, `visualViewport`, `resize`, `matchMedia`, `requestAnimationFrame` and
 * `getComputedStyle`. It is internal: `windowOf(renderer)` finds it, and its `document` is the
 * window's own. The first window's is the global `window` (`globalThis`) and `document`.
 */
export class GpuixWindow {
  readonly events: GpuixEventTarget
  readonly visualViewport = new VisualViewport(this)
  readonly frames = new FrameList()
  /** The renderer of the window, `undefined` while the global window has none yet. Set by the registry only. */
  renderer: NativeRenderer | undefined
  /** The window closed: its document is empty from then on, and the global one stays the closed window's. */
  closed = false
  /** A root is attached to the renderer (`attach` of its renderer state): set by the renderer state only. */
  attached = false

  /** What `resize` is sent to as its target. */
  private readonly self: object
  private readonly mounted: () => boolean
  #document: GpuixDocument | undefined

  constructor(links: WindowLinks) {
    this.self = links.owner ?? this
    this.mounted = links.mounted
    this.events = new GpuixEventTarget(() => {
      links.onTypesChange()
      this.syncResize()
    }, this.self)
  }

  /** The window's own document. */
  get document(): GpuixDocument {
    if (this.#document === undefined) throw new Error("The window has no document yet")
    return this.#document
  }

  /** @internal Made together with the window, by the registry. */
  bindDocument(document: GpuixDocument): void {
    this.#document = document
  }

  /** The renderer while a root is mounted in the window, else `undefined`. */
  get mountedRenderer(): NativeRenderer | undefined {
    return this.mounted() ? this.renderer : undefined
  }

  /** The window's renderer; throws before the window has one, as every member that reads native does. */
  requireRenderer(member: string): NativeRenderer {
    const renderer = this.renderer
    if (renderer === undefined || !this.mounted()) {
      throw new Error(`${member} needs a mounted GPUIX root. Read it after render().`)
    }
    return renderer
  }

  /** @internal */
  size(member: string): WindowSize {
    const renderer = this.requireRenderer(member)
    if (renderer.getWindowSize === undefined) {
      throw new Error(`This renderer does not report the window size, so ${member} cannot be read`)
    }
    return renderer.getWindowSize()
  }

  get innerWidth(): number {
    return this.size("innerWidth").width
  }

  get innerHeight(): number {
    return this.size("innerHeight").height
  }

  readonly scrollX = 0
  readonly scrollY = 0

  /** The document cannot scroll (Ghia has no scrolling element for the viewport), so these do nothing. */
  scrollTo(): void {}
  scroll(): void {}
  scrollBy(): void {}

  matchMedia(query: string): MediaQueryList {
    return hooks().matchMedia(this.requireRenderer("matchMedia"), String(query))
  }

  requestAnimationFrame(callback: (time: number) => void): number {
    return this.frames.request(callback)
  }

  cancelAnimationFrame(handle: number): void {
    this.frames.cancel(handle)
  }

  getComputedStyle(...args: Parameters<typeof getComputedStyle>): ReturnType<typeof getComputedStyle> {
    return hooks().getComputedStyle(...args)
  }

  addEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.events.addEventListener(type, listener, options)
  }

  removeEventListener(
    type: string,
    listener: WindowEventListener,
    options?: boolean | Pick<AddEventListenerOptions, "capture">
  ): void {
    this.events.removeEventListener(type, listener, options)
  }

  /**
   * Follows the `resize` listeners and the window's renderer: sends `resize` to `visualViewport` and
   * this window when the size of the window changes. A window's size changes arrive as its
   * `mediaChange` event, which also carries OS preference changes, so the event goes out only when
   * the size is not the one last seen. The subscription exists only while one of the two has a
   * `resize` listener and a root is mounted; call this when either may have changed.
   */
  syncResize(): void {
    installedHooks?.syncResize(this)
  }

  /** @internal What `resize` is sent to as its target. */
  get resizeTarget(): object {
    return this.self
  }

  /** @internal Whether anything listens for `resize` on the window or its visual viewport. */
  get listensForResize(): boolean {
    return this.visualViewport.listeners.hasListeners("resize") || this.events.hasListeners("resize")
  }

  /** @internal Whether a root is mounted in the window and it is open. */
  get isMounted(): boolean {
    return this.mounted()
  }
}
