import type { EventPayload } from "../index.js"
import {
  createDomEvent,
  reportHandlerErrors,
  reportUncaught,
  walkWindowTarget,
  type DomEventRoot,
} from "./events/dispatch.js"
import {
  beginDispatch,
  endDispatch,
  forgetWindowSource,
  globalWindow,
  knownWindowOf,
} from "./events/window-target.js"
import type { GpuixWindow, WindowPostMessageOptions } from "./events/window-targets.js"
import type { NativeRenderer } from "./host.js"
import { namedError } from "./named-error.js"
import { location } from "./shell/location.js"

/** What a window's own events carry as `view`, and where an error a listener throws goes. */
function rootOf(window: GpuixWindow): DomEventRoot {
  return { eventHandlers: new Map(), elementById: () => undefined, view: window.view }
}

/**
 * Sends `type` to the listeners of `window`, as the DOM sends the events of the window itself:
 * the target is the window, and only its own listeners hear it. Returns the event, so a caller
 * can read what a listener did to it.
 */
export function fireWindowEvent(window: GpuixWindow, type: string, fields: object = {}): Event {
  const root = rootOf(window)
  const payload = { elementId: 0, eventType: type, ...fields } as unknown as EventPayload
  const created = createDomEvent(root, payload, [], window.view)
  const errors: unknown[] = []
  walkWindowTarget(window.events, created.event, created.state, (error) => errors.push(error))
  reportHandlerErrors(root, errors)
  return created.event as unknown as Event
}

/**
 * The window whose event is running, so `postMessage` can say who sent a message: the window of the
 * renderer that delivered the event being handled. Outside an event handler it is the first window.
 */
let incumbent: GpuixWindow | undefined

/** @internal The renderer state runs the handlers of each event inside this, with the window the event happened in. */
export function runAsIncumbent<Result>(window: GpuixWindow, run: () => Result): Result {
  const previous = incumbent
  incumbent = window
  try {
    return run()
  } finally {
    incumbent = previous
  }
}

function incumbentWindow(): GpuixWindow {
  return incumbent ?? globalWindow()
}

const unloaded = new WeakSet<GpuixWindow>()

/** The windows a script opened by name, for a later `window.open(url, name)` to find. */
const opened = new Set<GpuixWindow>()

/** @internal Windows made by `window.open` are looked up by name while they are open. */
export function trackOpenedWindow(window: GpuixWindow): void {
  opened.add(window)
}

/** The open window called `name` (ASCII case-insensitively, as the HTML spec matches target names), the first window included. */
export function findNamedWindow(name: string): GpuixWindow | undefined {
  const wanted = name.toLowerCase()
  for (const window of [globalWindow(), ...opened]) {
    if (!window.closed && window.name.toLowerCase() === wanted) return window
  }
  return undefined
}

/** What an adapter's root of a window needs done once the window is gone: see `registerWindowFactory`. */
const disposers = new WeakMap<object, () => void>()

/** @internal Called by `window-open.ts` with what the adapter's factory returned. */
export function setWindowDisposer(renderer: object, dispose: () => void): void {
  disposers.set(renderer, dispose)
}

/**
 * Fires the events a window sends as it goes (`pagehide`, then `unload`), once. A close a script asks for
 * first sends `beforeunload`, whose result a script close ignores, as a browser's does.
 */
function sendUnload(window: GpuixWindow, scripted: boolean): void {
  if (unloaded.has(window)) return
  unloaded.add(window)
  if (scripted) fireWindowEvent(window, "beforeunload")
  fireWindowEvent(window, "pagehide", { persisted: false })
  fireWindowEvent(window, "unload")
}

/**
 * The renderer's window is gone, because the user closed it, a script did, or the app ended: its
 * window hears `pagehide` and `unload` (unless a script's `close()` sent them already), its document
 * is empty from then on, and the root the adapter mounted in it is let go.
 *
 * @internal Called by the frame loop when a window leaves it, and by `close()`.
 */
export function windowGone(renderer: NativeRenderer): void {
  const window = knownWindowOf(renderer)
  if (window === undefined) return
  sendUnload(window, false)
  opened.delete(window)
  forgetWindowSource(renderer)
  releaseAdapterRoot(renderer)
}

/** Lets go of the root the adapter mounted in the window, once. */
function releaseAdapterRoot(renderer: NativeRenderer): void {
  const dispose = disposers.get(renderer)
  disposers.delete(renderer)
  if (dispose === undefined) return
  try {
    dispose()
  } catch (error) {
    reportUncaught(error)
  }
}

export function closeWindowObject(window: GpuixWindow): void {
  const renderer = window.renderer
  if (window.closed || renderer === undefined) return
  if (renderer.closeWindow === undefined) {
    throw new Error("This renderer cannot close its window, so window.close() is unavailable")
  }
  sendUnload(window, true)
  // The root goes while the window is still there to take what unmounting it sends.
  releaseAdapterRoot(renderer)
  renderer.closeWindow()
  windowGone(renderer)
}

export function focusWindowObject(window: GpuixWindow): void {
  if (window.closed) return
  const renderer = window.requireRenderer("window.focus")
  if (renderer.activateWindow === undefined) {
    throw new Error("This renderer cannot activate its window, so window.focus() is unavailable")
  }
  renderer.activateWindow()
}

/** @internal The platform made the window the key window or took that from it: `window` hears `focus` or `blur`. */
export function deliverWindowActivity(window: GpuixWindow, active: boolean): void {
  fireWindowEvent(window, active ? "focus" : "blur")
}

export function dispatchOnWindow(window: GpuixWindow, event: Event): boolean {
  const state = beginDispatch(event, window.view)
  const errors: unknown[] = []
  walkWindowTarget(window.events, event as never, state, (error) => errors.push(error))
  endDispatch(state)
  errors.forEach(reportUncaught)
  return !event.defaultPrevented
}

function postMessageOptions(
  targetOrigin: string | WindowPostMessageOptions | undefined,
  transfer: Transferable[] | undefined
): { origin: string; transfer: Transferable[] } {
  if (typeof targetOrigin === "object" && targetOrigin !== null) {
    return { origin: targetOrigin.targetOrigin ?? "/", transfer: targetOrigin.transfer ?? [] }
  }
  return { origin: targetOrigin === undefined ? "/" : String(targetOrigin), transfer: transfer ?? [] }
}

/** Whether a message addressed to `targetOrigin` is for a window of this app: every window has the app's one origin. */
function addressesApp(targetOrigin: string): boolean {
  if (targetOrigin === "*" || targetOrigin === "/") return true
  let parsed: URL
  try {
    parsed = new URL(targetOrigin)
  } catch {
    throw namedError("SyntaxError", `Failed to execute 'postMessage' on 'Window': Invalid target origin '${targetOrigin}' in a call to 'postMessage'.`)
  }
  return parsed.origin === location.origin
}

/**
 * Delivers `message` to `window` in a later task, as `window.postMessage` does: a structured clone (a
 * value that cannot be cloned throws `DataCloneError` here), in a `MessageEvent` with the app's
 * origin and the sending window as `source`. The windows share one JS realm, so nothing else is
 * needed to cross from one to the other.
 */
export function postMessageToWindow(
  window: GpuixWindow,
  message: unknown,
  targetOrigin: string | WindowPostMessageOptions | undefined,
  transfer: Transferable[] | undefined
): void {
  const options = postMessageOptions(targetOrigin, transfer)
  const deliverable = addressesApp(options.origin)
  const data = structuredClone(message, options.transfer.length === 0 ? undefined : { transfer: options.transfer })
  if (!deliverable) return
  const source = incumbentWindow().view
  setTimeout(() => {
    if (window.closed) return
    const event = new MessageEvent("message", { data, origin: location.origin })
    // The runtime's MessageEvent only takes a MessagePort as its source.
    Object.defineProperty(event, "source", { value: source, configurable: true })
    dispatchOnWindow(window, event)
  }, 0)
}

export function resizeWindowObject(window: GpuixWindow, width: number, height: number): void {
  const renderer = window.requireRenderer("window.resizeTo")
  if (renderer.setWindowSize === undefined) {
    throw new Error("This renderer cannot resize its window, so window.resizeTo() is unavailable")
  }
  renderer.setWindowSize(width, height)
}

/** Device pixels per CSS px of the window's display; 1 while the window has no root yet, or on a renderer that has no screen. */
export function scaleFactorOf(window: GpuixWindow): number {
  const renderer = window.mountedRenderer
  if (renderer?.getScaleFactor === undefined) return 1
  return renderer.getScaleFactor()
}

/** Where the window is, in the global space of `getAllDisplays()`; the origin while the window has no root or no way to say. */
export function positionOf(window: GpuixWindow): { x: number; y: number } {
  const renderer = window.mountedRenderer
  if (renderer?.getWindowPosition === undefined) return { x: 0, y: 0 }
  return renderer.getWindowPosition()
}
