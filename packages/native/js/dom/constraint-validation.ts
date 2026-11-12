/**
 * The constraint validation API of `<input>` and `<textarea>`: `required`, `name`, `form`,
 * `willValidate`, `validity`, `validationMessage`, `setCustomValidity()`, `checkValidity()` and
 * `reportValidity()`. A form library asks the element and not the framework (Base UI's `Field`
 * reads `validity.valueMissing` on every change and shows `validationMessage`).
 *
 * Only what native enforces on submit is evaluated: `required` (a text control with no text, a
 * checkbox that is not checked, a radio group with none checked) and the custom message. The other
 * conditions (`pattern`, `minlength`, `min`, `max`, `step`, a type's format) read `false`. See
 * docs/fork/deviations.md.
 */

import { normalizedInputType } from "./input-type.js"
import type { Element } from "./nodes.js"
import { elementById } from "./selectors.js"
import { onTags } from "./tag-members.js"

const CONTROL_TAGS: ReadonlySet<string> = new Set(["input", "textarea"])
const NAMED_TAGS: ReadonlySet<string> = new Set(["button", "fieldset", "form", "input", "select", "textarea"])
const REQUIRABLE_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"])
const CONSTRUCT: unique symbol = Symbol("ValidityState")

/** The input types that are never validated: they hold no value the user enters. */
const BARRED_TYPES: ReadonlySet<string> = new Set(["hidden", "reset", "button", "submit", "image"])

/** The input types `readonly` does not bar: it has no meaning for them. */
const READONLY_IGNORED_TYPES: ReadonlySet<string> = new Set(["checkbox", "radio", "range", "color", "file", "hidden"])

const customMessages = new WeakMap<object, string>()

function typeOf(control: Element): string {
  if (control.localName === "textarea") return "textarea"
  return normalizedInputType(control.getAttribute("type"))
}

/** The form owner: the `<form>` the `form` attribute names, if it is one in the same tree; else the nearest ancestor `<form>`. */
function formOf(control: Element): Element | null {
  const id = control.getAttribute("form")
  if (id === null) return control.closest("form")
  const named = elementById(control.getRootNode(), id)
  return named !== null && named.localName === "form" ? named : null
}

function isBarred(control: Element): boolean {
  const type = typeOf(control)
  if (BARRED_TYPES.has(type)) return true
  if (control.hasAttribute("readonly") && !READONLY_IGNORED_TYPES.has(type)) return true
  return control.matches(":disabled")
}

/**
 * The radios that share `radio`'s group, itself included: those with its name and its form owner
 * (the same tree, for radios with none). A radio with no name is alone. This is native's rule for
 * checking one radio and unchecking the others (`radio_group`), except that a `form` attribute is
 * honoured here and not there.
 */
function radioGroupOf(radio: Element): Element[] {
  const name = radio.getAttribute("name")
  const document = radio.ownerDocument
  if (name === null || name === "" || document === null) return [radio]
  const form = formOf(radio)
  const root = radio.getRootNode()
  return Array.from(document.querySelectorAll("input")).filter(
    (other) =>
      other === radio ||
      (typeOf(other) === "radio" &&
        other.getAttribute("name") === name &&
        formOf(other) === form &&
        other.getRootNode() === root)
  )
}

/** A radio group is required when any of its radios is, and then it is missing while none is checked. */
function radioGroupIsMissing(radio: Element): boolean {
  const group = radioGroupOf(radio)
  return group.some((member) => member.hasAttribute("required")) && !group.some((member) => Reflect.get(member, "checked") === true)
}

function isValueMissing(control: Element): boolean {
  const type = typeOf(control)
  if (type === "radio") return radioGroupIsMissing(control)
  if (!control.hasAttribute("required")) return false
  if (type === "checkbox") return Reflect.get(control, "checked") !== true
  if (type === "range" || type === "color") return false
  return Reflect.get(control, "value") === ""
}

/** The DOM's `ValidityState`: a live view of one control. */
export class ValidityState {
  readonly #control: Element

  constructor(control: Element, token: typeof CONSTRUCT) {
    if (token !== CONSTRUCT) throw new TypeError("Illegal constructor")
    this.#control = control
  }

  get valueMissing(): boolean {
    return !isBarred(this.#control) && isValueMissing(this.#control)
  }

  get typeMismatch(): boolean {
    return false
  }

  get patternMismatch(): boolean {
    return false
  }

  get tooLong(): boolean {
    return false
  }

  get tooShort(): boolean {
    return false
  }

  get rangeUnderflow(): boolean {
    return false
  }

  get rangeOverflow(): boolean {
    return false
  }

  get stepMismatch(): boolean {
    return false
  }

  get badInput(): boolean {
    return false
  }

  get customError(): boolean {
    return (customMessages.get(this.#control) ?? "") !== ""
  }

  get valid(): boolean {
    return !this.valueMissing && !this.customError
  }
}

// WebIDL attributes are enumerable, where a class getter is not: `for (key in input.validity)` lists them.
for (const name of Object.getOwnPropertyNames(ValidityState.prototype)) {
  if (name !== "constructor") Object.defineProperty(ValidityState.prototype, name, { enumerable: true })
}

const validityStates = new WeakMap<object, ValidityState>()

function validityOf(control: Element): ValidityState {
  const existing = validityStates.get(control)
  if (existing !== undefined) return existing
  const created = new ValidityState(control, CONSTRUCT)
  validityStates.set(control, created)
  return created
}

function missingMessage(control: Element): string {
  const type = typeOf(control)
  if (type === "checkbox") return "Please check this box if you want to proceed."
  if (type === "radio") return "Please select one of these options."
  return "Please fill out this field."
}

function validationMessageOf(control: Element): string {
  if (isBarred(control)) return ""
  const custom = customMessages.get(control) ?? ""
  if (custom !== "") return custom
  return validityOf(control).valueMissing ? missingMessage(control) : ""
}

/** Fires the cancelable `invalid` event at a control whose check failed; false when a listener canceled it. */
function reportInvalid(control: Element): boolean {
  return control.dispatchEvent(new Event("invalid", { cancelable: true }))
}

function checkValidity(control: Element): boolean {
  if (isBarred(control)) return true
  if (validityOf(control).valid) return true
  reportInvalid(control)
  return false
}

function focusControl(control: Element): void {
  const focus = Reflect.get(control, "focus")
  if (typeof focus !== "function") throw new Error("reportValidity() needs an element that can take focus")
  focus.call(control)
}

/** `checkValidity()`, then, if no `invalid` listener canceled the event, focuses the control, which scrolls it into view. No message is shown. */
function reportValidity(control: Element): boolean {
  if (isBarred(control)) return true
  if (validityOf(control).valid) return true
  if (reportInvalid(control)) focusControl(control)
  return false
}

/** A method of the controls: on any other element it is `undefined`, as in the DOM. */
function method(name: string, run: (element: Element, argument: unknown) => unknown) {
  return onTags<Element>(
    name,
    CONTROL_TAGS,
    (element) => (argument: unknown) => run(element, argument),
    () => {
      throw new TypeError(`Cannot set property ${name} of an HTMLElement which has only a getter`)
    }
  )
}

/** Defines the members on `target`, which is the prototype of `Element`. */
export function defineConstraintValidation(target: object): void {
  Object.defineProperties(target, {
    required: onTags<Element>(
      "required",
      REQUIRABLE_TAGS,
      (element) => element.hasAttribute("required"),
      (element, value) => (value ? element.setAttribute("required", "") : element.removeAttribute("required"))
    ),
    name: onTags<Element>(
      "name",
      NAMED_TAGS,
      (element) => element.getAttribute("name") ?? "",
      (element, value) => element.setAttribute("name", String(value))
    ),
    form: onTags<Element>("form", CONTROL_TAGS, formOf, () => {
      throw new TypeError("Cannot set property form of an HTMLElement which has only a getter")
    }),
    willValidate: onTags<Element>("willValidate", CONTROL_TAGS, (element) => !isBarred(element), () => {
      throw new TypeError("Cannot set property willValidate of an HTMLElement which has only a getter")
    }),
    validity: onTags<Element>("validity", CONTROL_TAGS, validityOf, () => {
      throw new TypeError("Cannot set property validity of an HTMLElement which has only a getter")
    }),
    validationMessage: onTags<Element>("validationMessage", CONTROL_TAGS, validationMessageOf, () => {
      throw new TypeError("Cannot set property validationMessage of an HTMLElement which has only a getter")
    }),
    setCustomValidity: method("setCustomValidity", (element, message) => {
      customMessages.set(element, String(message))
    }),
    checkValidity: method("checkValidity", (element) => checkValidity(element)),
    reportValidity: method("reportValidity", (element) => reportValidity(element)),
  })
}
