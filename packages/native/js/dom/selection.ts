import { mountedRenderer } from "../mounted-renderer.js"
import type { NativeRenderer } from "../host.js"

const CREATE = Symbol("create selection")

function currentRenderer(member: string): NativeRenderer {
  const renderer = mountedRenderer()
  if (renderer === undefined) {
    throw new Error(`${member} needs a mounted GPUIX root. Read it after render().`)
  }
  return renderer
}

function selectedText(member: string): string | null {
  const renderer = currentRenderer(member)
  if (renderer.getSelectedText === undefined) {
    throw new Error(`This renderer does not report the text selection, so ${member} cannot be read`)
  }
  return renderer.getSelectedText()
}

/**
 * The text selection of the window that mounted last, shaped like the DOM's `Selection`. Ghia's
 * selection is a set of spans over painted text, not a range of nodes, so only what that can
 * answer is here: whether anything is selected, the selected text, and clearing it.
 */
abstract class SelectionClass {
  constructor(token?: symbol) {
    if (token !== CREATE) throw new TypeError("Illegal constructor")
  }

  /** 1 while any text is selected, 0 otherwise. */
  get rangeCount(): number {
    return selectedText("Selection.rangeCount") === null ? 0 : 1
  }

  get isCollapsed(): boolean {
    return selectedText("Selection.isCollapsed") === null
  }

  /** `Range` while text is selected. Ghia has no caret in painted text, so never `Caret`. */
  get type(): "None" | "Range" {
    return selectedText("Selection.type") === null ? "None" : "Range"
  }

  toString(): string {
    return selectedText("Selection.toString") ?? ""
  }

  removeAllRanges(): void {
    const renderer = currentRenderer("Selection.removeAllRanges")
    if (renderer.clearSelection === undefined) {
      throw new Error("This renderer cannot clear the text selection, so Selection.removeAllRanges is unavailable")
    }
    renderer.clearSelection()
  }

  empty(): void {
    this.removeAllRanges()
  }
}

Object.defineProperty(SelectionClass.prototype, Symbol.toStringTag, { value: "Selection", configurable: true })

type SelectionSet = { Selection: typeof SelectionClass; instance: SelectionClass }

const SELECTION_KEY = Symbol.for("@ghia/native/selection")

/**
 * Kept on `globalThis` like the DOM classes: a second copy of this package must share the class,
 * or `selection instanceof Selection` fails across copies, and `getSelection()` is one object.
 */
const shared: SelectionSet = (() => {
  const existing = Reflect.get(globalThis, SELECTION_KEY) as SelectionSet | undefined
  if (existing) return existing
  Object.defineProperty(SelectionClass, "name", { value: "Selection" })
  // The abstract class is only a type: the runtime class is concrete so the one instance can be made.
  const Selection = SelectionClass as unknown as new (token: symbol) => SelectionClass
  const created: SelectionSet = {
    Selection: SelectionClass,
    instance: new Selection(CREATE),
  }
  Reflect.set(globalThis, SELECTION_KEY, created)
  return created
})()

export const Selection = shared.Selection
export type Selection = SelectionClass

/** `document.getSelection()` and `window.getSelection()`: the one selection of the app. */
export function getSelection(): Selection {
  return shared.instance
}
