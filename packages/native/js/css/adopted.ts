import { observableArray, type ObservableArray } from "./observable-array.js"
import { setAdoptedSheets } from "./sheet-sync.js"
import { CSSStyleSheet } from "./style-sheet.js"

function convert(value: unknown): CSSStyleSheet {
  if (value instanceof CSSStyleSheet) return value
  throw new TypeError("Failed to set an item of 'adoptedStyleSheets' on 'Document': The value provided is not a CSSStyleSheet.")
}

let adopted: ObservableArray<CSSStyleSheet> | undefined

function current(): ObservableArray<CSSStyleSheet> {
  adopted ??= observableArray(convert, () => setAdoptedSheets(adopted!.array))
  return adopted
}

/** `document.adoptedStyleSheets`: one array for the document, however many windows it spans. */
export function getAdoptedStyleSheets(): CSSStyleSheet[] {
  return current().array
}

export function replaceAdoptedStyleSheets(sheets: Iterable<unknown>): void {
  current().replace(sheets)
}
