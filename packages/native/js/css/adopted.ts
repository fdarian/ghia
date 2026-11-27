import { observableArray, type ObservableArray } from "./observable-array.js"
import { CSSStyleSheet } from "./style-sheet.js"

function convert(value: unknown): CSSStyleSheet {
  if (value instanceof CSSStyleSheet) return value
  throw new TypeError("Failed to set an item of 'adoptedStyleSheets' on 'Document': The value provided is not a CSSStyleSheet.")
}

/** One document's `adoptedStyleSheets`: `onChange` hears every change that left it different. */
export function createAdoptedStyleSheets(onChange: (sheets: readonly CSSStyleSheet[]) => void): ObservableArray<CSSStyleSheet> {
  const adopted: ObservableArray<CSSStyleSheet> = observableArray(convert, () => onChange(adopted.array))
  return adopted
}

export type { CSSStyleSheet }
