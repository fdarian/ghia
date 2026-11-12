import { flushPendingMutations, HOST_BINDING, type HostBinding } from "../bounds.js"
import type { NativeRenderer } from "../host.js"
import type { InputChoiceState } from "../../index.js"
import { namedError } from "../named-error.js"
import { attributeText, inputAttributeValue } from "./attribute-names.js"
import { requiredMethod } from "./renderer-method.js"
import { onTags } from "./tag-members.js"

/** `checked`, `defaultChecked`, `indeterminate`, `value` and `defaultValue` of an `<input>`, which native holds. */
export interface InputMembers {
  /** The checkedness of a checkbox or radio. Setting it stops `defaultChecked` from deciding it, and a radio unchecks its group. */
  checked: boolean
  /** The `checked` attribute: what `checked` is until it is set or the user toggles the control. Assigning writes the attribute, as `setAttribute("checked", "")` does. */
  defaultChecked: boolean
  /** A property only, with no attribute. A user's toggle of a checkbox clears it. */
  indeterminate: boolean
  /** A text field's text; the `value` of a checkbox, radio or hidden input, `"on"` by default for the first two; a range's sanitized value. */
  value: string
  /** The `value` attribute of an `<input>`, `""` without one: what `value` is until it is set or the user edits the control. A `<textarea>`'s is its default text. Assigning writes the attribute. */
  defaultValue: string
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
  /** Sets the prop as the framework's own prop path does; see `DomElementBinding.setProp`. */
  setProp(name: string, value: string | number | boolean | undefined): void
}

type Layout = NonNullable<InputBinding["layout"]>

const INPUT_TAG: ReadonlySet<string> = new Set(["input"])
const VALUE_TAGS: ReadonlySet<string> = new Set(["input", "textarea"])

function isInput(self: object): boolean {
  return INPUT_TAG.has(Reflect.get(self, "localName") as string)
}

/** The state native holds for the `<input>` at `layout`, after the pending mutations are sent. */
export function readInputChoice(layout: Layout): InputChoiceState {
  const read = layout.renderer.getInputChoice
  if (typeof read !== "function") throw new Error("This renderer does not support getInputChoice, so an input has no checked state")
  flushPendingMutations(layout.renderer)
  return read.call(layout.renderer, layout.id)
}

/**
 * A property assignment is not an attribute and not a prop: it changes the control's own state, and
 * the framework's props, which a controlled control is restored to, stay as they were committed.
 * The state is native's, so the call is made once the pending mutations are sent.
 */
function writeFlag(layout: Layout, name: "checked" | "indeterminate", value: boolean): void {
  const write = requiredMethod(layout.renderer, "writeInputFlag", `${name} cannot be assigned`)
  flushPendingMutations(layout.renderer)
  write(layout.id, name, value)
}

function writeRangeValue(layout: Layout, text: string): void {
  const write = requiredMethod(layout.renderer, "writeRangeValue", "the value of a range cannot be assigned")
  flushPendingMutations(layout.renderer)
  write(layout.id, text)
}

/**
 * The `value` of a checkbox, radio or hidden input is its `value` attribute in the DOM (the
 * "default/on" mode), and a text field's is its text; native holds both as the prop, so this is the
 * one write that goes through `setCustomProp`.
 */
function writeValueProp(self: object, layout: Layout, value: string): void {
  const host = Reflect.get(self, HOST_BINDING) as (() => HostBinding | undefined) | undefined
  const binding = host?.call(self)
  if (binding === undefined) throw new Error("Setting value needs a mounted element")
  binding.mutations.setCustomProp(layout.id, "value", value)
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
  writeRangeValue(layout, String(Number(state.value) + direction * count * state.step))
}

/**
 * Defines `checked`, `defaultChecked`, `indeterminate`, `value` and `defaultValue` on `target`, which is the
 * prototype of an adapter's host elements. On anything but an `<input>` (`<textarea>` for `value`) they
 * read `undefined` and an assignment makes an own property, so no other element changes.
 */
export function defineInputMembers<This extends object>(target: object, bind: (self: This) => InputBinding): void {
  const onInput = (name: string, read: (self: This) => unknown, write: (self: This, value: unknown) => void) =>
    onTags<This>(name, INPUT_TAG, read, write)
  const flag = (name: "checked" | "indeterminate", prop: (binding: InputBinding) => boolean) =>
    onInput(
      name,
      (self) => {
        const binding = bind(self)
        return binding.layout === undefined ? prop(binding) : readInputChoice(binding.layout)[name]
      },
      (self, value) => {
        const layout = bind(self).layout
        if (layout === undefined) throw new Error(`Setting ${name} needs a mounted element`)
        writeFlag(layout, name, Boolean(value))
      }
    )
  const attribute = (name: "min" | "max" | "step") =>
    onInput(
      name,
      (self) => propText(bind(self).prop(name)),
      (self, value) => bind(self).setProp(name, String(value))
    )
  Object.defineProperties(target, {
    min: attribute("min"),
    max: attribute("max"),
    step: attribute("step"),
    valueAsNumber: onInput(
      "valueAsNumber",
      (self) => {
        const type = bind(self).prop("type")
        if (type !== "range" && type !== "number") return Number.NaN
        const text = Reflect.get(self, "value") as string
        return text === "" ? Number.NaN : Number(text)
      },
      (self, value) => {
        Reflect.set(self, "value", String(Number(value)))
      }
    ),
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
    // The `checked` attribute: the same write as `setAttribute("checked", "")`, so it is seen by `getAttribute`, a selector and observers.
    defaultChecked: onInput(
      "defaultChecked",
      (self) => {
        const binding = bind(self)
        return binding.layout === undefined ? Boolean(binding.prop("defaultChecked")) : readInputChoice(binding.layout).defaultChecked
      },
      (self, value) => bind(self).setProp("defaultChecked", value ? true : undefined)
    ),
    indeterminate: flag("indeterminate", () => false),
    defaultValue: onTags<This>(
      "defaultValue",
      VALUE_TAGS,
      (self) => {
        const binding = bind(self)
        if (!isInput(self)) return propText(binding.prop("defaultValue"))
        return attributeText("value", inputAttributeValue("value", (name) => binding.prop(name), binding.prop("type"))) ?? ""
      },
      (self, value) => {
        const text = String(value)
        if (isInput(self)) Reflect.apply(Reflect.get(self, "setAttribute") as (name: string, value: string) => void, self, ["value", text])
        else bind(self).setProp("defaultValue", text)
      }
    ),
    value: onTags<This>(
      "value",
      VALUE_TAGS,
      (self) => {
        const binding = bind(self)
        const layout = binding.layout
        if (layout === undefined) return propText(binding.prop("value") ?? binding.prop("defaultValue"))
        if (isInput(self)) {
          const state = readInputChoice(layout)
          if (state.kind !== "text") return state.value
        }
        const read = layout.renderer.getTextValue
        if (typeof read !== "function") throw new Error("This renderer does not support getTextValue, so a text input has no value to read")
        return read.call(layout.renderer, layout.id)
      },
      (self, value) => {
        const layout = bind(self).layout
        if (layout === undefined) throw new Error("Setting value needs a mounted element")
        const text = propText(value)
        if (isInput(self) && readInputChoice(layout).kind === "range") writeRangeValue(layout, text)
        else writeValueProp(self, layout, text)
      }
    ),
  })
}
