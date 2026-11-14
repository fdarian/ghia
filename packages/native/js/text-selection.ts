import type { NativeRenderer } from "./host.js"
import { normalizedInputType } from "./dom/input-type.js"
import { namedError } from "./named-error.js"

/** `selectionDirection` of an `<input>` or `<textarea>`. */
export type SelectionDirection = "forward" | "backward" | "none"

/**
 * The selection API a ref to an `<input>` or `<textarea>` carries, shaped like
 * the DOM. Offsets are UTF-16 code units. The getters are synchronous.
 */
export interface TextControlSelection {
  /** Select all of the text. Does not move focus. Does nothing for the types HTML does not apply it to (`checkbox`, `radio`, `range`, `hidden` and the buttons). */
  select(): void
  /**
   * Select `start` to `end`. Both clamp to the text, and an `end` at or before
   * `start` collapses the selection to `end`. `direction` defaults to `"none"`.
   */
  setSelectionRange(start: number, end: number, direction?: SelectionDirection): void
  /** `null` for an `<input>` of a type the selection API does not apply to (anything but `text`, `search`, `url`, `tel` and `password`), as in the DOM. */
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

/** The input types HTML says the selection API applies to; every other type reads `null` and cannot be set. */
const TYPES_WITH_TEXT_SELECTION: ReadonlySet<string> = new Set(["text", "search", "url", "tel", "password"])

/** The types `select()` does not apply to in HTML; every other type, `email` and `number` included, selects all. */
const TYPES_WITHOUT_SELECT: ReadonlySet<string> = new Set([
  "hidden", "checkbox", "radio", "range", "button", "submit", "image", "reset",
])

function hasTextSelection(host: TextControlHost): boolean {
  return TYPES_WITH_TEXT_SELECTION.has(normalizedInputType(host.inputType()))
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

/**
 * Selects all the text of every type HTML applies `select()` to, `email` and `number` included
 * though they have no `selectionStart`, and does nothing for the rest.
 */
export function selectTextControl(host: TextControlHost): void {
  if (TYPES_WITHOUT_SELECT.has(normalizedInputType(host.inputType()))) return
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

/** What the selection of a control that is not mounted needs to know of it. */
export interface UnmountedTextControl {
  inputType(): unknown
  /** The text the control has now, which its selection is measured against. */
  text(): string
  /** Whether `value` was assigned, which puts a caret that nobody placed at the end of the text. */
  valueWritten(): boolean
}

/**
 * The selection of an `<input>` or `<textarea>` that has no native element yet (a library builds
 * and configures one before it is inserted). Native holds the selection of a mounted control, so
 * until then it is kept here and answers as the DOM does with no native read: it clamps to the
 * text, and a control nobody selected in has its caret at the end of a text that was written to
 * `value` and at the start otherwise. It is not carried over to the native element when it mounts.
 */
export class UnmountedTextSelection {
  private range: { start: number; end: number; direction: SelectionDirection } | undefined

  constructor(private readonly control: UnmountedTextControl) {}

  select(): void {
    if (TYPES_WITHOUT_SELECT.has(normalizedInputType(this.control.inputType()))) return
    this.range = { start: 0, end: this.control.text().length, direction: "none" }
  }

  setRange(start: number, end: number, direction: SelectionDirection = "none"): void {
    if (!TYPES_WITH_TEXT_SELECTION.has(normalizedInputType(this.control.inputType()))) {
      throw namedError("InvalidStateError", `setSelectionRange() does not apply to <input type="${String(this.control.inputType())}">`)
    }
    const length = this.control.text().length
    const clampedEnd = Math.min(Math.max(end, 0), length)
    const clampedStart = Math.min(Math.max(start, 0), clampedEnd)
    this.range = { start: clampedStart, end: clampedEnd, direction }
  }

  read(): { start: number | null; end: number | null; direction: SelectionDirection | null } {
    if (!TYPES_WITH_TEXT_SELECTION.has(normalizedInputType(this.control.inputType()))) return { start: null, end: null, direction: null }
    const length = this.control.text().length
    if (this.range === undefined) {
      const caret = this.control.valueWritten() ? length : 0
      return { start: caret, end: caret, direction: "none" }
    }
    const end = Math.min(this.range.end, length)
    return { start: Math.min(this.range.start, end), end, direction: this.range.direction }
  }
}
