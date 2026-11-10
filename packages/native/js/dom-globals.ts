import { cancelAnimationFrame, requestAnimationFrame } from "./animation-frame.js"
import { ResizeObserver } from "./observers.js"
import { document, window } from "./events/window-target.js"
import type { AddEventListenerOptions, WindowEventListener } from "./events/window-target.js"
import { isWebBuild } from "./web-build.js"

type AddListener = (
  type: string,
  listener: WindowEventListener,
  options?: boolean | AddEventListenerOptions
) => void
type RemoveListener = (
  type: string,
  listener: WindowEventListener,
  options?: boolean | Pick<AddEventListenerOptions, "capture">
) => void

/**
 * Marks the install as done on `globalThis`, so a second evaluation of this module
 * (`bun --hot`, two copies of the package) does not wrap the listeners twice.
 */
const INSTALLED_KEY = Symbol.for("@ghia/native/dom-globals")

function install(): void {
  if (Reflect.get(globalThis, INSTALLED_KEY) === true) return
  Reflect.set(globalThis, INSTALLED_KEY, true)

  const runtimeAdd = Reflect.get(globalThis, "addEventListener") as AddListener | undefined
  const runtimeRemove = Reflect.get(globalThis, "removeEventListener") as RemoveListener | undefined
  const noScroll = () => {}

  // Both targets get every listener: Ghia's dispatches the input types and turns them on in
  // native, the runtime's keeps `error`, `unhandledrejection` and `message` working. Each
  // only dispatches its own types, so a listener is never called twice for one event. Node
  // has no global event target, so there Ghia's is the only one.
  Object.defineProperties(globalThis, {
    window: { value: globalThis, configurable: true, writable: true },
    document: { value: document, configurable: true, writable: true },
    addEventListener: {
      configurable: true,
      writable: true,
      value: ((type, listener, options) => {
        window.addEventListener(type, listener, options)
        runtimeAdd?.call(globalThis, type, listener, options)
      }) satisfies AddListener,
    },
    removeEventListener: {
      configurable: true,
      writable: true,
      value: ((type, listener, options) => {
        window.removeEventListener(type, listener, options)
        runtimeRemove?.call(globalThis, type, listener, options)
      }) satisfies RemoveListener,
    },
    // The frame steps of a window run the callbacks, before the frame that paints what they change.
    requestAnimationFrame: { value: requestAnimationFrame, configurable: true, writable: true },
    cancelAnimationFrame: { value: cancelAnimationFrame, configurable: true, writable: true },
    // Ghia has no document scrolling element, so the viewport cannot scroll.
    scrollTo: { value: noScroll, configurable: true, writable: true },
    scroll: { value: noScroll, configurable: true, writable: true },
    scrollBy: { value: noScroll, configurable: true, writable: true },
  })
  // A runtime that has its own keeps it, which is what a library that takes `window.ResizeObserver` gets elsewhere.
  if (Reflect.get(globalThis, "ResizeObserver") === undefined) {
    Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserver, configurable: true, writable: true })
  }
}

if (!isWebBuild) install()
