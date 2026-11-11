import { flushPendingMutations, HOST_BINDING, type HostBinding } from "../bounds.js"
import type { NativeRenderer } from "../host.js"
import type { InputChoiceState } from "../../index.js"

/** `checked`, `defaultChecked`, `indeterminate` and `value` of an `<input>`, which native holds. */
export interface InputMembers {
  /** The checkedness of a checkbox or radio. Setting it stops `defaultChecked` from deciding it, and a radio unchecks its group. */
  checked: boolean
  /** The `defaultChecked` prop: what `checked` is until it is set or the user toggles the control. */
  defaultChecked: boolean
  /** A property only, with no attribute. A user's toggle of a checkbox clears it. */
  indeterminate: boolean
  /** A text field's text; the `value` of a checkbox, radio or hidden input, `"on"` by default for the first two. */
  value: string
}

/** What the members need of an element: where it is mounted, and the props it was given. */
export interface InputBinding {
  readonly layout: { renderer: NativeRenderer; id: number } | undefined
  prop(name: string): unknown
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
  Object.defineProperties(target, {
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
