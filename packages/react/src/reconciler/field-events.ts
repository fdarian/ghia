import type { HostEventHandler } from "@ghia/native/host"
import type { Props } from "../types/host.js"

/** What an element listens for to run its `onInput` and `onChange` props, as React DOM wires them. */
export interface FieldHandlers {
  readonly input: HostEventHandler | undefined
  readonly change: HostEventHandler | undefined
}

/**
 * React DOM runs `onChange` on every edit of a text control (the DOM `input` event), and on the
 * click of a checkbox or radio (the DOM `change`). Ghia's `onChange` is the DOM's, so React's props
 * are keyed by element: a text control hears `input` for both props, a checkbox or radio keeps
 * `onInput` on `input` and `onChange` on `change`, and any other element, which hears the events
 * of the controls below it as React's `onChange` does, takes `input` from text controls and
 * `change` from checkboxes and radios.
 */
export function fieldHandlers(elementType: string, props: Props): FieldHandlers {
  const record = props as Record<string, unknown>
  const onInput = record.onInput as HostEventHandler | undefined
  const onChange = record.onChange as HostEventHandler | undefined
  if (elementType === "input" && isChoiceType(record.type)) return { input: onInput, change: onChange }
  if (elementType === "input" || elementType === "textarea") return { input: inOrder(onInput, onChange), change: undefined }
  if (onChange === undefined) return { input: onInput, change: undefined }
  return {
    input: inOrder(onInput, onlyFor(onChange, false)),
    change: onlyFor(onChange, true),
  }
}

function isChoiceType(type: unknown): boolean {
  return type === "checkbox" || type === "radio"
}

function isChoice(target: unknown): boolean {
  const instance = target as { elementType?: unknown; props?: Record<string, unknown> } | null
  return instance?.elementType === "input" && isChoiceType(instance.props?.type)
}

// A handler that is the same function in two commits has to be the same function out of here, or
// every commit would register it again.
const sequences = new WeakMap<HostEventHandler, WeakMap<HostEventHandler, HostEventHandler>>()
const filtered = new WeakMap<HostEventHandler, { choice?: HostEventHandler; text?: HostEventHandler }>()

/** `onInput` and then `onChange`, the order React DOM runs them in. */
function inOrder(first: HostEventHandler | undefined, second: HostEventHandler | undefined): HostEventHandler | undefined {
  if (first === undefined || second === undefined) return first ?? second
  let bySecond = sequences.get(first)
  if (bySecond === undefined) sequences.set(first, (bySecond = new WeakMap()))
  let both = bySecond.get(second)
  if (both === undefined) {
    both = (event) => {
      try {
        first(event)
      } finally {
        second(event)
      }
    }
    bySecond.set(second, both)
  }
  return both
}

function onlyFor(handler: HostEventHandler, choice: boolean): HostEventHandler {
  let byKind = filtered.get(handler)
  if (byKind === undefined) filtered.set(handler, (byKind = {}))
  const key = choice ? "choice" : "text"
  return (byKind[key] ??= (event) => {
    if (isChoice(event.target) === choice) handler(event)
  })
}
