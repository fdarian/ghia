/**
 * What a dispatch records about its event, for both kinds of event it walks: one Ghia delivered
 * from native input (`delivered-events.ts`, which keeps this under `STATE`) and one an app built
 * with the runtime's constructor and passed to `dispatchEvent`.
 *
 * The runtime's `Event` has `target`, `currentTarget`, `eventPhase` and the stop methods as
 * accessors and functions of its own, which a dispatch that is not the runtime's cannot drive. An
 * app's event gets own accessors that read this state, defined once for the event, and wrapped
 * stop methods that record into it and call the runtime's.
 */

export interface DispatchState {
  propagationStopped: boolean
  immediatePropagationStopped: boolean
  /** Between the start and the end of a walk: a second `dispatchEvent` of the event throws. */
  dispatching: boolean
  /** `composedPath()` while the event is dispatched, as elements, target first. */
  path: readonly object[]
}

export const STATE = Symbol.for("@ghia/native/event-state")

class ShadowState implements DispatchState {
  propagationStopped: boolean
  immediatePropagationStopped = false
  dispatching = false
  path: readonly object[] = []
  target: object | null = null
  currentTarget: object | null = null
  eventPhase = 0

  constructor(stopped: boolean) {
    this.propagationStopped = stopped
  }
}

const shadows = new WeakMap<object, ShadowState>()

const runtime = {
  stopPropagation: Event.prototype.stopPropagation,
  stopImmediatePropagation: Event.prototype.stopImmediatePropagation,
  cancelBubble: Object.getOwnPropertyDescriptor(Event.prototype, "cancelBubble")?.get,
}

function installShadow(event: Event): ShadowState {
  if (runtime.cancelBubble === undefined) {
    throw new Error("The runtime's Event has no cancelBubble getter, so an event cannot be dispatched through Ghia.")
  }
  // An event stopped before its first dispatch reaches no listener, as in the DOM.
  const state = new ShadowState(runtime.cancelBubble.call(event))
  shadows.set(event, state)
  Object.defineProperties(event, {
    target: {
      configurable: true,
      get: () => state.target,
      set: (value: object | null) => {
        state.target = value
      },
    },
    srcElement: { configurable: true, get: () => state.target },
    currentTarget: {
      configurable: true,
      get: () => state.currentTarget,
      set: (value: object | null) => {
        state.currentTarget = value
      },
    },
    eventPhase: {
      configurable: true,
      get: () => state.eventPhase,
      set: (value: number) => {
        state.eventPhase = value
      },
    },
    cancelBubble: {
      configurable: true,
      get: () => state.propagationStopped,
      set: (value: boolean) => {
        if (value) state.propagationStopped = true
      },
    },
    stopPropagation: {
      configurable: true,
      writable: true,
      value() {
        state.propagationStopped = true
        runtime.stopPropagation.call(event)
      },
    },
    stopImmediatePropagation: {
      configurable: true,
      writable: true,
      value() {
        state.propagationStopped = true
        state.immediatePropagationStopped = true
        runtime.stopImmediatePropagation.call(event)
      },
    },
    composedPath: { configurable: true, writable: true, value: () => [...state.path] },
    nativeEvent: { configurable: true, get: () => event },
  })
  return state
}

/** The state of `event`'s dispatch, shadowing the runtime's accessors of an app's event on first use. */
export function dispatchStateOf(event: Event): DispatchState {
  const delivered: unknown = Reflect.get(event, STATE)
  if (delivered !== undefined) return delivered as DispatchState
  return shadows.get(event) ?? installShadow(event)
}
