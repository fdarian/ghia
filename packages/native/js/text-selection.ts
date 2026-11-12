import type { NativeRenderer } from "./host.js"
import { namedError } from "./named-error.js"

/** `selectionDirection` of an `<input>` or `<textarea>`. */
export type SelectionDirection = "forward" | "backward" | "none"

/**
 * The selection API a ref to an `<input>` or `<textarea>` carries, shaped like
 * the DOM. Offsets are UTF-16 code units. The getters are synchronous.
 */
export interface TextControlSelection {
  /** Select all of the text. Does not move focus. */
  select(): void
  /**
   * Select `start` to `end`. Both clamp to the text, and an `end` at or before
   * `start` collapses the selection to `end`. `direction` defaults to `"none"`.
   */
  setSelectionRange(start: number, end: number, direction?: SelectionDirection): void
  /** `null` for an `<input>` whose type has no text to select (`checkbox`, `radio`, `range`, `hidden`), as in the DOM. */
  readonly selectionStart: number | null
  readonly selectionEnd: number | null
  readonly selectionDirection: SelectionDirection | null
}

/** What an adapter hands the helpers below for one text control. */
export interface TextControlHost {
  id: number
  nativeRenderer: NativeRenderer
  /** Apply queued mutations, so the element and its latest props exist natively. */
  flushMutations(): void
  /** The `type` the control has now: `undefined` for a `<textarea>` and for an `<input>` that was given none. */
  inputType(): unknown
}

/** The input types that draw no text: native has no selection for them, and the DOM's `selectionStart` is `null`. */
const TYPES_WITHOUT_TEXT_SELECTION: ReadonlySet<unknown> = new Set(["checkbox", "radio", "range", "hidden"])

function hasTextSelection(host: TextControlHost): boolean {
  return !TYPES_WITHOUT_TEXT_SELECTION.has(host.inputType())
}

type SelectionNative = Required<
  Pick<NativeRenderer, "selectText" | "setSelectionRange" | "getTextSelection">
>

function native(host: TextControlHost): SelectionNative {
  const renderer = host.nativeRenderer
  if (!renderer.selectText || !renderer.setSelectionRange || !renderer.getTextSelection) {
    throw new Error("This renderer does not support the text selection API")
  }
  host.flushMutations()
  return renderer as SelectionNative
}

/** Does nothing for a type with no text to select, as `select()` does in the DOM. */
export function selectTextControl(host: TextControlHost): void {
  if (!hasTextSelection(host)) return
  native(host).selectText(host.id)
}

export function setTextControlSelectionRange(
  host: TextControlHost,
  start: number,
  end: number,
  direction?: SelectionDirection
): void {
  if (!hasTextSelection(host)) {
    throw namedError("InvalidStateError", `setSelectionRange() does not apply to <input type="${String(host.inputType())}">`)
  }
  native(host).setSelectionRange(host.id, start, end, direction)
}

export function readTextControlSelection(host: TextControlHost): {
  start: number | null
  end: number | null
  direction: SelectionDirection | null
} {
  if (!hasTextSelection(host)) return { start: null, end: null, direction: null }
  const selection = native(host).getTextSelection(host.id)
  return {
    start: selection.start,
    end: selection.end,
    direction: selection.direction as SelectionDirection,
  }
}
