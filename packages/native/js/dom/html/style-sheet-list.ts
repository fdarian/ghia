/**
 * `document.styleSheets` of a parsed document: one `CSSStyleSheet` for each `<style>` element, made
 * with the CSSOM that constructed sheets have (`css/style-sheet.ts`). The sheets are for reading
 * (`cssRules`, `selectorText`, `style`); nothing applies them to rendering, and a window's
 * `document.styleSheets` is not this: only `adoptedStyleSheets` reach the renderer.
 */

import { CSSStyleSheet } from "../../css/style-sheet.js"
import { indexedView } from "../indexed-view.js"
import { findDescendants } from "../selectors.js"
import { treeVersion } from "../tree-version.js"
import type { Node } from "../nodes.js"

const SOURCE = Symbol("style sheets")

function sheetsOf(list: object): () => readonly CSSStyleSheet[] {
  return Reflect.get(list, SOURCE) as () => readonly CSSStyleSheet[]
}

/** The read-only, array-like list `document.styleSheets` is. */
export class StyleSheetList {
  readonly [index: number]: CSSStyleSheet

  constructor() {
    throw new TypeError("Illegal constructor")
  }

  get length(): number {
    return sheetsOf(this)().length
  }

  item(index: number): CSSStyleSheet | null {
    return sheetsOf(this)()[Number(index)] ?? null
  }

  [Symbol.iterator](): IterableIterator<CSSStyleSheet> {
    return sheetsOf(this)()[Symbol.iterator]()
  }
}

Object.defineProperty(StyleSheetList.prototype, Symbol.toStringTag, { value: "StyleSheetList", configurable: true })

/** The sheet a `<style>` element made, and the text it was made from: a changed text makes a new sheet. */
type Made = { readonly text: string; readonly sheet: CSSStyleSheet }

export function styleSheetsOf(document: Node): StyleSheetList {
  const made = new WeakMap<Node, Made>()
  let version = -1
  let current: readonly CSSStyleSheet[] = []
  const sheets = (): readonly CSSStyleSheet[] => {
    if (version === treeVersion()) return current
    version = treeVersion()
    current = findDescendants(document, (element) => element.localName === "style").map((style) => {
      const text = style.textContent ?? ""
      const known = made.get(style)
      if (known !== undefined && known.text === text) return known.sheet
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(text)
      Object.defineProperty(sheet, "ownerNode", { value: style, configurable: true })
      made.set(style, { text, sheet })
      return sheet
    })
    return current
  }
  const list = Object.create(StyleSheetList.prototype) as StyleSheetList
  Object.defineProperty(list, SOURCE, { value: sheets })
  return indexedView(list, { length: () => sheets().length, at: (index) => sheets()[index] })
}
