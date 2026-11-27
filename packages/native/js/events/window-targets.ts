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
  lifecycle: WindowLifecycle
}

/** What a window does that reaches outside it (opens, closes, asks the platform): `window-lifecycle.ts` and `window-open.ts`. */
export type WindowLifecycle = {
  open(opener: GpuixWindow, url: string | URL, target: string, features: string): object | null
  close(window: GpuixWindow): void
  focus(window: GpuixWindow): void
  postMessage(window: GpuixWindow, message: unknown, targetOrigin: string | WindowPostMessageOptions | undefined, transfer: Transferable[] | undefined): void
  dispatchEvent(window: GpuixWindow, event: Event): boolean
  resizeTo(window: GpuixWindow, width: number, height: number): void
  scaleFactor(window: GpuixWindow): number
  position(window: GpuixWindow): { x: number; y: number }
}

export type WindowPostMessageOptions = { targetOrigin?: string; transfer?: Transferable[] }

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

const WINDOW_TOKEN = Symbol("Window")

/**
 * The `Window` interface: `window instanceof Window` holds for the global object, which is the first
 * window, and for every window Ghia opens (`GpuixWindow`). A window object answers what it does not
 * define itself (`Promise`, `HTMLElement`, `setTimeout`, `fetch`, `location`, `localStorage`) with
 * the global object's: there is one JS realm, so they are the same objects.
 */
export class Window {
  constructor(token?: symbol) {
    if (token !== WINDOW_TOKEN) throw new TypeError("Illegal constructor")
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return value === globalThis || Function.prototype[Symbol.hasInstance].call(this, value)
  }
}

Object.setPrototypeOf(Window.prototype, Object.create(globalThis))

/** The event handler properties of a window object: `onresize` and the rest. */
const HANDLER_TYPES = ["resize", "focus", "blur", "beforeunload", "pagehide", "pageshow", "unload", "message"] as const
type HandlerType = (typeof HANDLER_TYPES)[number]
export type WindowEventHandler = ((this: object, event: Event) => unknown) | null

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
export class GpuixWindow extends Window {
  readonly events: GpuixEventTarget
  readonly visualViewport = new VisualViewport(this)
  /** The `requestAnimationFrame` callbacks of the window. */
  readonly animationFrames = new FrameList()
  /** The renderer of the window, `undefined` while the global window has none yet. Set by the registry only. */
  renderer: NativeRenderer | undefined
  /** The window closed: its document is empty from then on, and the global one stays the closed window's. */
  closed = false
  /** A root is attached to the renderer (`attach` of its renderer state): set by the renderer state only. */
  attached = false
  /** `window.name`: what a later `window.open(url, name)` finds the window by. */
  name = ""
  /** @internal The window that opened this one with `window.open`, until `noopener` or `opener = null`. */
  openerLink: GpuixWindow | null = null

  /** What the window is to code: the global object for the first window, the window target itself for another. The `currentTarget` of its own listeners, the `target` of `resize` and the `view` of its events. */
  readonly view: object
  private readonly mounted: () => boolean
  #document: GpuixDocument | undefined

  constructor(links: WindowLinks) {
    super(WINDOW_TOKEN)
    this.view = links.owner ?? this
    this.mounted = links.mounted
    this.events = new GpuixEventTarget(() => {
      links.onTypesChange()
      this.syncResize()
    }, this.view)
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

  /** The window itself: the global object for the first window. */
  get window(): object {
    return this.view
  }

  get self(): object {
    return this.view
  }

  get frames(): object {
    return this.view
  }

  /** Ghia has no frames, so a window is its own `parent` and `top`. */
  get parent(): object {
    return this.view
  }

  get top(): object {
    return this.view
  }

  readonly frameElement = null
  readonly length = 0

  /** The window that opened this one with `window.open`, or `null`. It stays after that window closes. */
  get opener(): object | null {
    return this.openerLink?.view ?? null
  }

  set opener(value: null) {
    if (value !== null) throw new TypeError("opener can only be set to null")
    this.openerLink = null
  }

  open(url: string | URL = "", target = "_blank", features = ""): object | null {
    return hooks().lifecycle.open(this, url, String(target), String(features))
  }

  /** Fires `beforeunload`, `pagehide` and `unload` on this window and closes it. */
  close(): void {
    hooks().lifecycle.close(this)
  }

  /** Brings the window forward and makes it the key window. */
  focus(): void {
    hooks().lifecycle.focus(this)
  }

  /** Does nothing: nothing in the platform resigns the key window to another of the app's windows. */
  blur(): void {}

  postMessage(message: unknown, targetOrigin?: string | WindowPostMessageOptions, transfer?: Transferable[]): void {
    hooks().lifecycle.postMessage(this, message, targetOrigin, transfer)
  }

  dispatchEvent(event: Event): boolean {
    return hooks().lifecycle.dispatchEvent(this, event)
  }

  /** Sets the size of the window's content, as `resizeTo` does. */
  resizeTo(width: number, height: number): void {
    hooks().lifecycle.resizeTo(this, Number(width), Number(height))
  }

  resizeBy(width: number, height: number): void {
    const size = this.size("resizeBy")
    hooks().lifecycle.resizeTo(this, size.width + Number(width), size.height + Number(height))
  }

  /** Does nothing: GPUI places a window when it opens and cannot move it after. */
  moveTo(): void {}
  moveBy(): void {}

  /** The window's frame is not measured apart from its content, so it is `innerWidth`. */
  get outerWidth(): number {
    return this.innerWidth
  }

  get outerHeight(): number {
    return this.innerHeight
  }

  get devicePixelRatio(): number {
    return hooks().lifecycle.scaleFactor(this)
  }

  get screenX(): number {
    return hooks().lifecycle.position(this).x
  }

  get screenY(): number {
    return hooks().lifecycle.position(this).y
  }

  get screenLeft(): number {
    return this.screenX
  }

  get screenTop(): number {
    return this.screenY
  }

  getSelection(): ReturnType<GpuixDocument["getSelection"]> {
    return this.document.getSelection()
  }

  /** `location` is the app's one: setting it navigates it. */
  get location(): Location {
    return Reflect.get(globalThis, "location")
  }

  set location(value: string | URL) {
    Reflect.set(globalThis, "location", String(value))
  }

  readonly #handlers = new Map<HandlerType, { handler: WindowEventHandler; listening: boolean }>()

  /** @internal The `on<type>` property of a window: one listener, added when a handler is first set, calls the current one. */
  handlerOf(type: HandlerType): WindowEventHandler {
    return this.#handlers.get(type)?.handler ?? null
  }

  /** @internal */
  setHandler(type: HandlerType, value: unknown): void {
    const slot = this.#handlers.get(type) ?? { handler: null, listening: false }
    this.#handlers.set(type, slot)
    slot.handler = typeof value === "function" ? (value as WindowEventHandler) : null
    if (slot.handler === null || slot.listening) return
    slot.listening = true
    this.events.addEventListener(type, (event) => {
      slot.handler?.call(this.view, event as unknown as Event)
    })
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
    return this.animationFrames.request(callback)
  }

  cancelAnimationFrame(handle: number): void {
    this.animationFrames.cancel(handle)
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

  /** @internal Whether anything listens for `resize` on the window or its visual viewport. */
  get listensForResize(): boolean {
    return this.visualViewport.listeners.hasListeners("resize") || this.events.hasListeners("resize")
  }

  /** @internal Whether a root is mounted in the window and it is open. */
  get isMounted(): boolean {
    return this.mounted()
  }
}

export interface GpuixWindow extends Record<`on${HandlerType}`, WindowEventHandler> {}

for (const type of HANDLER_TYPES) {
  Object.defineProperty(GpuixWindow.prototype, `on${type}`, {
    configurable: true,
    enumerable: true,
    get(this: GpuixWindow) {
      return this.handlerOf(type)
    },
    set(this: GpuixWindow, value: unknown) {
      this.setHandler(type, value)
    },
  })
}

/** The `on<type>` handler properties, for the global object to carry as the first window's. */
export const WINDOW_HANDLER_TYPES: readonly string[] = HANDLER_TYPES
