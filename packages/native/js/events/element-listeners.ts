import type { EventHandlerMap, HostEventHandler, MutationRenderer } from "../host.js"
import {
  captureHandlerKey,
  LISTENER_RUNNER,
  reportUncaught,
  type DomEvent,
  type ListenerRunner,
} from "./dispatch.js"
import { registerEventListener, unregisterEventListener } from "./listeners.js"

/** Where the dispatch of an app's event finds the listeners of an element: a method of the DOM members that returns its `ElementListeners`. */
export const DOM_LISTENERS: unique symbol = Symbol.for("@ghia/native/dom-listeners")

/** `addEventListener`'s second argument, shaped like the DOM's. */
export type ElementEventListener =
  | ((event: DomEvent) => void)
  | { handleEvent(event: DomEvent): void }

export interface ElementListenerOptions {
  /** Listen in the capture phase. */
  capture?: boolean
  /** Remove the listener before its first call. */
  once?: boolean
  /** `preventDefault()` does nothing while the listener runs. */
  passive?: boolean
  /** Removes the listener when it aborts. A signal that is aborted already adds nothing. */
  signal?: AbortSignal
}

/** Where the lists of one element register: the root's handler map and the native side. */
export interface ListenerSink {
  readonly eventHandlers: EventHandlerMap
  readonly renderer: Pick<MutationRenderer, "setEventListener" | "flushMutations">
  readonly elementId: number
}

type Entry =
  | { readonly kind: "prop"; readonly handler: HostEventHandler }
  | {
      readonly kind: "listener"
      readonly listener: ElementEventListener
      readonly capture: boolean
      readonly once: boolean
      readonly passive: boolean
      stopWatching: (() => void) | undefined
    }

/** What a type has in one phase: the entries in the order the DOM calls them. */
interface List {
  readonly entries: Entry[]
  runner: ListenerRunner | undefined
}

/**
 * A key with only its `on*` prop holds that handler itself, which is what every element had before
 * listeners existed. A key a listener was added for holds a `List`.
 */
type Slot = HostEventHandler | List

/** The handler map key of a listener of `type` in a phase, the same one the `on*` prop of it is stored under. */
function keyOf(type: string, capture: boolean): string {
  return capture ? captureHandlerKey(type) : type
}

function captureOf(options: boolean | Pick<ElementListenerOptions, "capture"> | undefined): boolean {
  return typeof options === "boolean" ? options : options?.capture === true
}

function same(entry: Entry, listener: ElementEventListener): boolean {
  return entry.kind === "listener" && entry.listener === listener
}

/**
 * The event listeners of one element, with its `on*` props among them: for each type and phase one
 * list, in which a prop is an entry like a listener, placed where it was first set (the way the
 * DOM orders an event handler attribute), replaced in place and taken out when unset.
 *
 * The element keeps this for its life. It is registered with `attach` while the element exists on
 * the native side (a Solid element is created natively on every insertion), and what is registered
 * is a type that has an entry, in either phase.
 */
export class ElementListeners {
  readonly #slots = new Map<string, Slot>()
  #sink: ListenerSink | undefined

  /** The element now exists natively: registers every type that has an entry. */
  attach(sink: ListenerSink): void {
    this.#sink = sink
    for (const key of this.#slots.keys()) this.#sync(key)
  }

  /** The element is gone natively, and its handlers with it. */
  detach(): void {
    this.#sink = undefined
  }

  /**
   * The handler the element has under `key` (the type, or the type and `Capture`), which is what
   * `attach` registers in the root's handler map: the dispatch of an app's event reads it here
   * instead, so it needs neither the root nor an id, and reaches an element that is not mounted.
   */
  get(key: string): HostEventHandler | undefined {
    const slot = this.#slots.get(key)
    return slot === undefined ? undefined : this.#handlerOf(key, slot)
  }

  /** Sets the `on*` prop that is stored under `key`, or unsets it with `undefined`. */
  setProp(key: string, handler: HostEventHandler | undefined): void {
    const slot = this.#slots.get(key)
    if (slot === undefined || typeof slot === "function") {
      if (handler === undefined) this.#slots.delete(key)
      else this.#slots.set(key, handler)
    } else {
      const index = slot.entries.findIndex((entry) => entry.kind === "prop")
      if (handler === undefined) {
        if (index >= 0) slot.entries.splice(index, 1)
      } else if (index >= 0) {
        slot.entries[index] = { kind: "prop", handler }
      } else {
        slot.entries.push({ kind: "prop", handler })
      }
      if (slot.entries.length === 0) this.#slots.delete(key)
    }
    this.#sync(key)
  }

  addEventListener(
    type: string,
    listener: ElementEventListener | null,
    options?: boolean | ElementListenerOptions
  ): void {
    if (listener === null || listener === undefined) return
    const capture = captureOf(options)
    const key = keyOf(type, capture)
    const once = typeof options === "object" && options.once === true
    const passive = typeof options === "object" && options.passive === true
    const signal = typeof options === "object" ? options.signal : undefined
    if (signal?.aborted) return
    let slot = this.#slots.get(key)
    if (typeof slot === "function") {
      slot = { entries: [{ kind: "prop", handler: slot }], runner: undefined }
      this.#slots.set(key, slot)
    } else if (slot === undefined) {
      slot = { entries: [], runner: undefined }
      this.#slots.set(key, slot)
    }
    if (slot.entries.some((entry) => same(entry, listener))) return
    const entry: Entry = { kind: "listener", listener, capture, once, passive, stopWatching: undefined }
    slot.entries.push(entry)
    if (signal) {
      const abort = () => this.removeEventListener(type, listener, capture)
      signal.addEventListener("abort", abort, { once: true })
      entry.stopWatching = () => signal.removeEventListener("abort", abort)
    }
    this.#sync(key)
    this.#send()
  }

  removeEventListener(
    type: string,
    listener: ElementEventListener | null,
    options?: boolean | Pick<ElementListenerOptions, "capture">
  ): void {
    if (listener === null || listener === undefined) return
    const key = keyOf(type, captureOf(options))
    const slot = this.#slots.get(key)
    if (slot === undefined || typeof slot === "function") return
    const index = slot.entries.findIndex((entry) => same(entry, listener))
    if (index < 0) return
    const [removed] = slot.entries.splice(index, 1)
    if (removed.kind === "listener") removed.stopWatching?.()
    if (slot.entries.length === 0) this.#slots.delete(key)
    this.#sync(key)
    this.#send()
  }

  /**
   * A call of the DOM API is made outside the commit or the batch that sends a prop, and a React
   * root only sends at the end of a commit: the listener would not reach native until the next one.
   */
  #send(): void {
    this.#sink?.renderer.flushMutations()
  }

  /** Makes the handler map and native say what the slot of `key` says. */
  #sync(key: string): void {
    const sink = this.#sink
    if (!sink) return
    const slot = this.#slots.get(key)
    if (slot === undefined) {
      unregisterEventListener(sink.eventHandlers, sink.renderer, sink.elementId, key)
      return
    }
    registerEventListener(sink.eventHandlers, sink.renderer, sink.elementId, key, this.#handlerOf(key, slot))
  }

  #handlerOf(key: string, slot: Slot): HostEventHandler {
    if (typeof slot === "function") return slot
    const only = slot.entries[0]
    if (slot.entries.length === 1 && only.kind === "prop") return only.handler
    slot.runner ??= this.#runnerOf(key, slot)
    return slot.runner
  }

  #runnerOf(key: string, list: List): ListenerRunner {
    const run: ListenerRunner[typeof LISTENER_RUNNER] = (event, state, fail) => {
      // A listener added during the dispatch waits for the next one, and one removed during it is
      // not called, as in the DOM.
      for (const entry of [...list.entries]) {
        if (state?.immediatePropagationStopped) return
        if (!list.entries.includes(entry)) continue
        try {
          if (entry.kind === "prop") {
            entry.handler(event)
            continue
          }
          if (entry.once) this.#removeEntry(key, list, entry)
          callListener(entry, event)
        } catch (error) {
          fail(error)
        }
      }
    }
    return Object.assign(
      (event: DomEvent) => {
        // Called as a plain handler: nobody to give the dispatch state to, and the first error is thrown.
        const errors: unknown[] = []
        run(event, undefined, (error) => errors.push(error))
        errors.slice(1).forEach(reportUncaught)
        if (errors.length > 0) throw errors[0]
      },
      { [LISTENER_RUNNER]: run }
    )
  }

  #removeEntry(key: string, list: List, entry: Entry): void {
    const index = list.entries.indexOf(entry)
    if (index < 0) return
    list.entries.splice(index, 1)
    if (entry.kind === "listener") entry.stopWatching?.()
    if (list.entries.length === 0 && this.#slots.get(key) === list) this.#slots.delete(key)
    this.#sync(key)
  }
}

function callListener(entry: Entry & { kind: "listener" }, event: DomEvent): void {
  const listener = entry.listener
  const call = () => {
    if (typeof listener === "function") listener.call(event.currentTarget, event)
    else listener.handleEvent(event)
  }
  if (!entry.passive) {
    call()
    return
  }
  // The method is an own property of the event. Restored even when the listener throws, for the
  // listeners that run after it.
  const preventDefault = event.preventDefault
  event.preventDefault = () => {}
  try {
    call()
  } finally {
    event.preventDefault = preventDefault
  }
}
