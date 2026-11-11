import { flushPendingMutations, HOST_BINDING, type HostBinding } from "../bounds.js"
import type { NativeRenderer } from "../host.js"
import type { InputChoiceState } from "../../index.js"
import { namedError } from "../named-error.js"

/** `checked`, `defaultChecked`, `indeterminate` and `value` of an `<input>`, which native holds. */
export interface InputMembers {
  /** The checkedness of a checkbox or radio. Setting it stops `defaultChecked` from deciding it, and a radio unchecks its group. */
  checked: boolean
  /** The `defaultChecked` prop: what `checked` is until it is set or the user toggles the control. */
  defaultChecked: boolean
  /** A property only, with no attribute. A user's toggle of a checkbox clears it. */
  indeterminate: boolean
  /** A text field's text; the `value` of a checkbox, radio or hidden input, `"on"` by default for the first two; a range's sanitized value. */
  value: string
  /** `type="number"` and `"range"`: `value` as a number, `NaN` for text that is none or another type. Assigning writes `value`. */
  valueAsNumber: number
  /** The `min`, `max` and `step` attributes as text, `""` when absent. A range sanitizes its value against them. */
  min: string
  max: string
  step: string
  /** A range: moves `value` by `count` steps (clamped and snapped, with no event). Throws an `InvalidStateError` for `step="any"` or another type. */
  stepUp(count?: number): void
  stepDown(count?: number): void
}

/** What the members need of an element: where it is mounted, and the props it was given. */
export interface InputBinding {
  readonly layout: { renderer: NativeRenderer; id: number } | undefined
  prop(name: string): unknown
  /** Sets the prop as the framework's own prop path does; see `DomElementBinding.writeProp`. */
  writeProp(name: string, value: string | number | boolean | undefined): void
}

type Layout = NonNullable<InputBinding["layout"]>

function isInput(self: object): boolean {
  return Reflect.get(self, "localName") === "input"
}

function hasValue(self: object): boolean {
  return isInput(self) || Reflect.get(self, "localName") === "textarea"
}

/** The state native holds for the `<input>` at `layout`, after the pending mutations are sent. */
export function readInputChoice(layout: Layout): InputChoiceState {
  const read = layout.renderer.getInputChoice
  if (typeof read !== "function") throw new Error("This renderer does not support getInputChoice, so an input has no checked state")
  flushPendingMutations(layout.renderer)
  return read.call(layout.renderer, layout.id)
}

/**
 * Writes the prop as native's own state sees it, without touching the framework's props: a
 * property assignment on a DOM element is not an attribute, and the framework's next commit of
 * the prop writes it again.
 */
function writeNative(self: object, layout: Layout, name: string, value: string | boolean): void {
  const host = Reflect.get(self, HOST_BINDING) as (() => HostBinding | undefined) | undefined
  const binding = host?.call(self)
  if (binding === undefined) throw new Error(`Setting ${name} needs a mounted element`)
  binding.mutations.setCustomProp(layout.id, name, value)
  binding.mutations.flushMutations()
}

function propText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value)
}

function stepBy<This extends object>(self: This, bind: (self: This) => InputBinding, count: number, direction: 1 | -1): void {
  const layout = bind(self).layout
  if (layout === undefined) throw new Error("Stepping a value needs a mounted element")
  const state = readInputChoice(layout)
  if (state.kind !== "range") throw namedError("InvalidStateError", "stepUp and stepDown are only supported on a range input")
  if (state.step === 0) throw namedError("InvalidStateError", "This form element does not have an allowed value step")
  // Native sanitizes what it is written, so the result is clamped and snapped as the DOM's.
  writeNative(self, layout, "value", String(Number(state.value) + direction * count * state.step))
}

/** A member of an element that is not an `<input>` is a plain property, as it is before these accessors exist. */
function plain(self: object, name: string, value: unknown): void {
  Object.defineProperty(self, name, { value, writable: true, configurable: true, enumerable: true })
}

/**
 * Defines `checked`, `defaultChecked`, `indeterminate` and `value` on `target`, which is the
 * prototype of an adapter's host elements. On anything but an `<input>` (`<textarea>` for `value`) they
 * read `undefined` and an assignment makes an own property, so no other element changes.
 */
export function defineInputMembers<This extends object>(target: object, bind: (self: This) => InputBinding): void {
  const flag = (name: "checked" | "defaultChecked" | "indeterminate", prop: (binding: InputBinding) => boolean) => ({
    configurable: true,
    get(this: This): boolean | undefined {
      if (!isInput(this)) return undefined
      const binding = bind(this)
      return binding.layout === undefined ? prop(binding) : readInputChoice(binding.layout)[name]
    },
    set(this: This, value: unknown) {
      if (!isInput(this)) return plain(this, name, value)
      const layout = bind(this).layout
      if (layout === undefined) throw new Error(`Setting ${name} needs a mounted element`)
      writeNative(this, layout, name, Boolean(value))
    },
  })
  const attribute = (name: "min" | "max" | "step") => ({
    configurable: true,
    get(this: This): string | undefined {
      return isInput(this) ? propText(bind(this).prop(name)) : undefined
    },
    set(this: This, value: unknown) {
      if (!isInput(this)) return plain(this, name, value)
      bind(this).writeProp(name, String(value))
    },
  })
  Object.defineProperties(target, {
    min: attribute("min"),
    max: attribute("max"),
    step: attribute("step"),
    valueAsNumber: {
      configurable: true,
      get(this: This): number | undefined {
        if (!isInput(this)) return undefined
        const type = bind(this).prop("type")
        if (type !== "range" && type !== "number") return Number.NaN
        const text = Reflect.get(this, "value") as string
        return text === "" ? Number.NaN : Number(text)
      },
      set(this: This, value: unknown) {
        if (!isInput(this)) return plain(this, "valueAsNumber", value)
        Reflect.set(this, "value", String(Number(value)))
      },
    },
    stepUp: {
      configurable: true,
      writable: true,
      value(this: This, count = 1) {
        stepBy(this, bind, count, 1)
      },
    },
    stepDown: {
      configurable: true,
      writable: true,
      value(this: This, count = 1) {
        stepBy(this, bind, count, -1)
      },
    },
    checked: flag("checked", (binding) => Boolean(binding.prop("checked") ?? binding.prop("defaultChecked"))),
    defaultChecked: flag("defaultChecked", (binding) => Boolean(binding.prop("defaultChecked"))),
    indeterminate: flag("indeterminate", () => false),
    value: {
      configurable: true,
      get(this: This): string | undefined {
        if (!hasValue(this)) return undefined
        const binding = bind(this)
        const layout = binding.layout
        if (layout === undefined) return propText(binding.prop("value"))
        if (Reflect.get(this, "localName") === "input") {
          const state = readInputChoice(layout)
          if (state.kind !== "text") return state.value
        }
        const read = layout.renderer.getTextSelection
        if (typeof read !== "function") throw new Error("This renderer does not support getTextSelection, so a text input has no value to read")
        return read.call(layout.renderer, layout.id).value
      },
      set(this: This, value: unknown) {
        if (!hasValue(this)) return plain(this, "value", value)
        const layout = bind(this).layout
        if (layout === undefined) throw new Error("Setting value needs a mounted element")
        writeNative(this, layout, "value", propText(value))
      },
    },
  })
}
