/**
 * The events Ghia delivers from native input. They are instances of the DOM classes
 * (`classes.ts`) but are built without the runtime's `Event` constructor, which is several times
 * the cost of the object literal they replace and whose `isTrusted` is an own accessor that
 * cannot be configured on Bun. Each is `Object.create` of a prototype made once per event type,
 * which carries what is the same for every event of the type (`type`, `bubbles`, `cancelable`,
 * the DOM's defaults), and shadows every accessor of `Event.prototype` with a data property, so
 * the runtime's accessors, which throw on an object they did not construct, are never reached.
 *
 * What follows from that is listed in docs/fork/deviations.md: the inherited native methods
 * (`initEvent`) throw, and a delivered event cannot be passed to a runtime `EventTarget`.
 */

import {
  AnimationEvent,
  CompositionEvent,
  DragEvent,
  FocusEvent,
  InputEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  TransitionEvent,
  UIEvent,
  WheelEvent,
} from "./classes.js"
import { STATE, type DispatchState } from "./event-state.js"

export interface DeliveredFields {
  [STATE]: DispatchState
  defaultPrevented: boolean
  readonly cancelable: boolean
  target: object | null
}

type Delivered = DeliveredFields & Record<string, unknown>

type EventClass = { readonly prototype: object }

interface TypeSpec {
  readonly cls: EventClass
  /** Carries `shiftKey`, `ctrlKey`, `altKey` and `metaKey`. */
  readonly modifiers: boolean
  /** A click no pointer made has `isPrimary` false. */
  readonly pointer: boolean
}

const PLAIN: TypeSpec = { cls: Event, modifiers: false, pointer: false }

function typesOf(spec: TypeSpec, types: string[]): Array<[string, TypeSpec]> {
  return types.map((type) => [type, spec])
}

const POINTER_TYPES = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "pointercancel",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "gotpointercapture",
  "lostpointercapture",
  // Chrome makes these PointerEvents too.
  "click",
  "auxclick",
  "contextmenu",
]

const SPECS: ReadonlyMap<string, TypeSpec> = new Map([
  ...typesOf({ cls: PointerEvent, modifiers: true, pointer: true }, POINTER_TYPES),
  ...typesOf(
    { cls: MouseEvent, modifiers: true, pointer: false },
    ["dblclick", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave", "mousedownoutside"]
  ),
  ...typesOf({ cls: WheelEvent, modifiers: true, pointer: false }, ["wheel"]),
  ...typesOf(
    { cls: DragEvent, modifiers: true, pointer: false },
    ["drag", "dragstart", "dragend", "dragenter", "dragover", "dragleave", "drop"]
  ),
  ...typesOf({ cls: KeyboardEvent, modifiers: true, pointer: false }, ["keydown", "keyup"]),
  ...typesOf({ cls: FocusEvent, modifiers: false, pointer: false }, ["focus", "blur", "focusin", "focusout"]),
  ...typesOf({ cls: InputEvent, modifiers: false, pointer: false }, ["input"]),
  ...typesOf(
    { cls: CompositionEvent, modifiers: false, pointer: false },
    ["compositionstart", "compositionupdate", "compositionend"]
  ),
  ...typesOf(
    { cls: TransitionEvent, modifiers: false, pointer: false },
    ["transitionrun", "transitionstart", "transitionend", "transitioncancel"]
  ),
  ...typesOf(
    { cls: AnimationEvent, modifiers: false, pointer: false },
    ["animationstart", "animationiteration", "animationend", "animationcancel"]
  ),
])

/** The members the DOM's classes give an event that native does not send. */
const DEFAULTS: ReadonlyMap<EventClass, Record<string, unknown>> = new Map([
  // The DOM's `view` of a trusted event is the window.
  [UIEvent, { view: globalThis, detail: 0 }],
  [PointerEvent, {
    width: 1,
    height: 1,
    pressure: 0,
    tangentialPressure: 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    altitudeAngle: Math.PI / 2,
    azimuthAngle: 0,
  }],
  [MouseEvent, { screenX: 0, screenY: 0 }],
  [WheelEvent, { deltaZ: 0 }],
  [DragEvent, { dataTransfer: null }],
  [KeyboardEvent, { location: 0, charCode: 0 }],
])

/** Every class whose own defaults a delivered event of that class has, nearest first. */
function defaultsFor(cls: EventClass): Record<string, unknown> {
  const chain: EventClass[] = []
  for (let proto: object | null = cls.prototype; proto !== null; proto = Object.getPrototypeOf(proto)) {
    const constructor: unknown = Reflect.get(proto, "constructor")
    if (typeof constructor === "function") chain.push(constructor as EventClass)
  }
  const merged: Record<string, unknown> = {}
  for (const link of chain.reverse()) Object.assign(merged, DEFAULTS.get(link))
  return merged
}

/** The accessors of `Event.prototype`, each replaced by a data property on a delivered event's prototype. */
const SHADOWED = [
  "composed",
  "timeStamp",
  "target",
  "currentTarget",
  "eventPhase",
  "defaultPrevented",
] as const

function stateOf(event: Delivered): DispatchState {
  return event[STATE]
}

const SHARED: PropertyDescriptorMap = {
  isTrusted: { value: true, writable: true, configurable: true },
  srcElement: { configurable: true, get(this: Delivered) { return this.target } },
  cancelBubble: {
    configurable: true,
    get(this: Delivered) {
      return stateOf(this).propagationStopped
    },
    set(this: Delivered, value: boolean) {
      if (value) stateOf(this).propagationStopped = true
    },
  },
  returnValue: {
    configurable: true,
    get(this: Delivered) {
      return !this.defaultPrevented
    },
    set(this: Delivered, value: boolean) {
      if (!value && this.cancelable) this.defaultPrevented = true
    },
  },
  nativeEvent: { configurable: true, get(this: Delivered) { return this } },
  stopPropagation: {
    configurable: true,
    writable: true,
    value(this: Delivered) {
      stateOf(this).propagationStopped = true
    },
  },
  stopImmediatePropagation: {
    configurable: true,
    writable: true,
    value(this: Delivered) {
      const state = stateOf(this)
      state.propagationStopped = true
      state.immediatePropagationStopped = true
    },
  },
  preventDefault: {
    configurable: true,
    writable: true,
    value(this: Delivered) {
      if (this.cancelable) this.defaultPrevented = true
    },
  },
  composedPath: {
    configurable: true,
    writable: true,
    value(this: Delivered) {
      return [...stateOf(this).path]
    },
  },
}

export interface DeliveredType {
  readonly prototype: object
  readonly modifiers: boolean
  readonly pointer: boolean
}

const types = new Map<string, DeliveredType>()

function buildPrototype(type: string, spec: TypeSpec, bubbles: boolean, cancelable: boolean): object {
  const prototype = Object.create(spec.cls.prototype)
  Object.defineProperties(prototype, SHARED)
  for (const name of SHADOWED) {
    Object.defineProperty(prototype, name, { value: undefined, writable: true, configurable: true })
  }
  const constants: Record<string, unknown> = {
    type,
    bubbles,
    cancelable,
    composed: false,
    currentTarget: null,
    eventPhase: 0,
    defaultPrevented: false,
    ...defaultsFor(spec.cls),
  }
  for (const name of Object.keys(constants)) {
    Object.defineProperty(prototype, name, { value: constants[name], writable: true, configurable: true })
  }
  return prototype
}

/** The class and prototype events of `type` are delivered with, once `defineDeliveredType` made them. */
export function lookupDeliveredType(type: string): DeliveredType | undefined {
  return types.get(type)
}

/**
 * Makes the prototype of the events delivered with `type`, which is the string native sent: the
 * lowercase DOM name, or a camelCase one for the few it still sends that way. `bubbles` and
 * `cancelable` are what `dispatch.ts` knows of the type.
 */
export function defineDeliveredType(type: string, bubbles: boolean, cancelable: boolean): DeliveredType {
  const spec = SPECS.get(type.toLowerCase()) ?? PLAIN
  const built = {
    prototype: buildPrototype(type, spec, bubbles, cancelable),
    modifiers: spec.modifiers,
    pointer: spec.pointer,
  }
  types.set(type, built)
  return built
}
