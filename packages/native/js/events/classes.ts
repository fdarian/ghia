/**
 * The DOM's event classes, as the runtime's own `Event` subclasses, so `instanceof Event` holds and
 * `new (element.ownerDocument.defaultView.PointerEvent)("click", { shiftKey: true })` builds an
 * event `dispatchEvent` accepts. `dom-globals` installs them where the runtime has none.
 *
 * The events Ghia delivers from native input are instances of these classes too, but are built
 * without the runtime's constructor: see `delivered-events.ts`.
 */

/** The four modifiers of `EventModifierInit`, plus the ones no platform reports to Ghia. */
export interface EventModifierInit {
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  modifierAltGraph?: boolean
  modifierCapsLock?: boolean
  modifierFn?: boolean
  modifierFnLock?: boolean
  modifierHyper?: boolean
  modifierNumLock?: boolean
  modifierScrollLock?: boolean
  modifierSuper?: boolean
  modifierSymbol?: boolean
  modifierSymbolLock?: boolean
}

const EXTRA_MODIFIERS = [
  "AltGraph",
  "CapsLock",
  "Fn",
  "FnLock",
  "Hyper",
  "NumLock",
  "ScrollLock",
  "Super",
  "Symbol",
  "SymbolLock",
] as const

/** The extra modifiers an event was built with, kept off the event: almost none has any. */
const extraModifiers = new WeakMap<object, ReadonlySet<string>>()

interface ModifierFields {
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
}

/** `getModifierState` of a mouse or keyboard event. */
function getModifierState(this: ModifierFields, key: string): boolean {
  switch (String(key)) {
    case "Shift":
      return this.shiftKey
    case "Control":
      return this.ctrlKey
    case "Alt":
      return this.altKey
    case "Meta":
      return this.metaKey
    default: {
      const extra = extraModifiers.get(this)
      return extra !== undefined && extra.has(String(key))
    }
  }
}

function readModifiers(event: object, init: EventModifierInit): ModifierFields {
  const extra = new Set<string>()
  for (const name of EXTRA_MODIFIERS) {
    if (init[`modifier${name}`] === true) extra.add(name)
  }
  if (extra.size > 0) extraModifiers.set(event, extra)
  return {
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
  }
}

function defineConstants(target: object, constants: Record<string, number>): void {
  for (const name of Object.keys(constants)) {
    Object.defineProperty(target, name, { value: constants[name], enumerable: true })
  }
}

export interface UIEventInit extends EventInit {
  view?: object | null
  detail?: number
}

export class UIEvent extends Event {
  readonly view: object | null
  readonly detail: number

  constructor(type: string, init: UIEventInit = {}) {
    super(type, init)
    this.view = init.view ?? null
    this.detail = init.detail ?? 0
  }
}

export interface MouseEventInit extends UIEventInit, EventModifierInit {
  screenX?: number
  screenY?: number
  clientX?: number
  clientY?: number
  movementX?: number
  movementY?: number
  button?: number
  buttons?: number
  relatedTarget?: object | null
}

export class MouseEvent extends UIEvent {
  readonly screenX: number
  readonly screenY: number
  readonly clientX: number
  readonly clientY: number
  readonly movementX: number
  readonly movementY: number
  readonly button: number
  readonly buttons: number
  readonly relatedTarget: object | null
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean

  constructor(type: string, init: MouseEventInit = {}) {
    super(type, init)
    this.screenX = init.screenX ?? 0
    this.screenY = init.screenY ?? 0
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
    this.movementX = init.movementX ?? 0
    this.movementY = init.movementY ?? 0
    this.button = init.button ?? 0
    this.buttons = init.buttons ?? 0
    this.relatedTarget = init.relatedTarget ?? null
    const modifiers = readModifiers(this, init)
    this.ctrlKey = modifiers.ctrlKey
    this.shiftKey = modifiers.shiftKey
    this.altKey = modifiers.altKey
    this.metaKey = modifiers.metaKey
  }

  getModifierState(key: string): boolean {
    return getModifierState.call(this, key)
  }
}

export interface PointerEventInit extends MouseEventInit {
  pointerId?: number
  width?: number
  height?: number
  pressure?: number
  tangentialPressure?: number
  tiltX?: number
  tiltY?: number
  twist?: number
  altitudeAngle?: number
  azimuthAngle?: number
  pointerType?: string
  isPrimary?: boolean
}

export class PointerEvent extends MouseEvent {
  readonly pointerId: number
  readonly width: number
  readonly height: number
  readonly pressure: number
  readonly tangentialPressure: number
  readonly tiltX: number
  readonly tiltY: number
  readonly twist: number
  readonly altitudeAngle: number
  readonly azimuthAngle: number
  readonly pointerType: string
  readonly isPrimary: boolean

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
    this.width = init.width ?? 1
    this.height = init.height ?? 1
    this.pressure = init.pressure ?? 0
    this.tangentialPressure = init.tangentialPressure ?? 0
    this.tiltX = init.tiltX ?? 0
    this.tiltY = init.tiltY ?? 0
    this.twist = init.twist ?? 0
    this.altitudeAngle = init.altitudeAngle ?? Math.PI / 2
    this.azimuthAngle = init.azimuthAngle ?? 0
    this.pointerType = init.pointerType ?? ""
    this.isPrimary = init.isPrimary ?? false
  }
}

export interface WheelEventInit extends MouseEventInit {
  deltaX?: number
  deltaY?: number
  deltaZ?: number
  deltaMode?: number
}

const DELTA_MODES = { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 }

export class WheelEvent extends MouseEvent {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaZ: number
  readonly deltaMode: number

  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init)
    this.deltaX = init.deltaX ?? 0
    this.deltaY = init.deltaY ?? 0
    this.deltaZ = init.deltaZ ?? 0
    this.deltaMode = init.deltaMode ?? 0
  }
}
defineConstants(WheelEvent, DELTA_MODES)
defineConstants(WheelEvent.prototype, DELTA_MODES)

export interface DragEventInit extends MouseEventInit {
  dataTransfer?: object | null
}

export class DragEvent extends MouseEvent {
  readonly dataTransfer: object | null

  constructor(type: string, init: DragEventInit = {}) {
    super(type, init)
    this.dataTransfer = init.dataTransfer ?? null
  }
}

export interface KeyboardEventInit extends UIEventInit, EventModifierInit {
  key?: string
  code?: string
  location?: number
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  charCode?: number
}

const KEY_LOCATIONS = {
  DOM_KEY_LOCATION_STANDARD: 0,
  DOM_KEY_LOCATION_LEFT: 1,
  DOM_KEY_LOCATION_RIGHT: 2,
  DOM_KEY_LOCATION_NUMPAD: 3,
}

export class KeyboardEvent extends UIEvent {
  readonly key: string
  readonly code: string
  readonly location: number
  readonly repeat: boolean
  readonly isComposing: boolean
  readonly keyCode: number
  readonly charCode: number
  readonly which: number
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean

  constructor(type: string, init: KeyboardEventInit = {}) {
    super(type, init)
    this.key = init.key ?? ""
    this.code = init.code ?? ""
    this.location = init.location ?? 0
    this.repeat = init.repeat ?? false
    this.isComposing = init.isComposing ?? false
    this.keyCode = init.keyCode ?? 0
    this.charCode = init.charCode ?? 0
    this.which = this.keyCode
    const modifiers = readModifiers(this, init)
    this.ctrlKey = modifiers.ctrlKey
    this.shiftKey = modifiers.shiftKey
    this.altKey = modifiers.altKey
    this.metaKey = modifiers.metaKey
  }

  getModifierState(key: string): boolean {
    return getModifierState.call(this, key)
  }
}
defineConstants(KeyboardEvent, KEY_LOCATIONS)
defineConstants(KeyboardEvent.prototype, KEY_LOCATIONS)

export interface FocusEventInit extends UIEventInit {
  relatedTarget?: object | null
}

export class FocusEvent extends UIEvent {
  readonly relatedTarget: object | null

  constructor(type: string, init: FocusEventInit = {}) {
    super(type, init)
    this.relatedTarget = init.relatedTarget ?? null
  }
}

export interface InputEventInit extends UIEventInit {
  data?: string | null
  isComposing?: boolean
  inputType?: string
  dataTransfer?: object | null
}

export class InputEvent extends UIEvent {
  readonly data: string | null
  readonly isComposing: boolean
  readonly inputType: string
  readonly dataTransfer: object | null

  constructor(type: string, init: InputEventInit = {}) {
    super(type, init)
    this.data = init.data ?? null
    this.isComposing = init.isComposing ?? false
    this.inputType = init.inputType ?? ""
    this.dataTransfer = init.dataTransfer ?? null
  }
}

export interface CompositionEventInit extends UIEventInit {
  data?: string
}

export class CompositionEvent extends UIEvent {
  readonly data: string

  constructor(type: string, init: CompositionEventInit = {}) {
    super(type, init)
    this.data = init.data ?? ""
  }
}

export interface TransitionEventInit extends EventInit {
  propertyName?: string
  elapsedTime?: number
  pseudoElement?: string
}

export class TransitionEvent extends Event {
  readonly propertyName: string
  readonly elapsedTime: number
  readonly pseudoElement: string

  constructor(type: string, init: TransitionEventInit = {}) {
    super(type, init)
    this.propertyName = init.propertyName ?? ""
    this.elapsedTime = init.elapsedTime ?? 0
    this.pseudoElement = init.pseudoElement ?? ""
  }
}

export interface AnimationEventInit extends EventInit {
  animationName?: string
  elapsedTime?: number
  pseudoElement?: string
}

export class AnimationEvent extends Event {
  readonly animationName: string
  readonly elapsedTime: number
  readonly pseudoElement: string

  constructor(type: string, init: AnimationEventInit = {}) {
    super(type, init)
    this.animationName = init.animationName ?? ""
    this.elapsedTime = init.elapsedTime ?? 0
    this.pseudoElement = init.pseudoElement ?? ""
  }
}

/** What `dom-globals` installs where the runtime has none. */
export const EVENT_CLASSES = {
  UIEvent,
  MouseEvent,
  PointerEvent,
  WheelEvent,
  DragEvent,
  KeyboardEvent,
  FocusEvent,
  InputEvent,
  CompositionEvent,
  TransitionEvent,
  AnimationEvent,
}
