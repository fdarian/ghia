/**
 * What typing does in an editing host: the `beforeinput` and `input` events of an edit and the
 * change to the DOM between them. The edit goes through the DOM (`insertData`, `deleteContents`), so
 * a `MutationObserver` records it and live ranges and the selection move as they would in Chrome.
 *
 * Phase 1 edits text only. A paragraph or line break fires `beforeinput` and changes nothing; an
 * edit that would join two blocks or remove a `<br>` (a Backspace over a block edge) fires
 * `beforeinput` and changes nothing, and text typed over a selection that spans two blocks goes
 * into the block it began in without joining them; an emptied Text node stays in the tree. A
 * Backspace or Delete next to a `contenteditable="false"` element removes it whole.
 */

import { Node, type Element, type Text } from "../dom/nodes.js"
import { createTextFor, Range, StaticRange } from "../dom/range.js"
import { getSelection, holdsNodeSelection } from "../dom/selection.js"
import { stepPoint } from "../dom/selection-movement.js"
import { CompositionEvent, InputEvent } from "../events/classes.js"
import { document } from "../events/window-target.js"
import { editingHostOf } from "./host.js"

const TEXT_NODE = 3

export interface EditingInputOptions {
  isComposing?: boolean
  /** The text an `insertCompositionText` replaces, kept by the caller; on return it spans the inserted text. */
  replacing?: Range
  /** Runs after an uncanceled `beforeinput` and before the DOM changes: where `compositionupdate` goes. */
  beforeChange?: () => void
}

export interface EditingInputResult {
  /** An editing host holds the selection and focus, so the edit was attempted. */
  handled: boolean
  /** A `beforeinput` listener canceled it. */
  canceled: boolean
  /** The DOM changed, and `input` fired. */
  changed: boolean
}

const NOT_HANDLED: EditingInputResult = { handled: false, canceled: false, changed: false }

interface EditingTarget {
  host: Element
  range: Range
}

/** `document.activeElement` as a DOM node. */
export function focusedNode(): Node {
  const active: unknown = document.activeElement
  if (!(active instanceof Node)) throw new Error("document.activeElement is not a DOM node")
  return active
}

function editingTarget(): EditingTarget | null {
  if (!holdsNodeSelection()) return null
  const selection = getSelection()
  const focus = selection.focusNode
  const anchor = selection.anchorNode
  if (focus === null || anchor === null) return null
  const host = editingHostOf(focus)
  if (host === null || editingHostOf(anchor) !== host) return null
  if (editingHostOf(focusedNode()) !== host) return null
  return { host, range: selection.getRangeAt(0).cloneRange() }
}

function staticRangeOf(range: Range): StaticRange {
  return new StaticRange({
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  })
}

function rangeBetween(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Range {
  const range = new Range()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

interface Deletion {
  range: Range
  /** The range is a `contenteditable="false"` element, which goes whole. */
  island: boolean
}

/** What one Backspace or Delete removes: the selection, or one character from the caret, or the whole non-editable element the caret is next to. */
function deletionRange(host: Element, selected: Range, forward: boolean): Deletion {
  if (!selected.collapsed) return { range: selected, island: false }
  const node = selected.startContainer
  const offset = selected.startOffset
  const step = stepPoint(host, node, offset, forward, "character")
  if (step === null) return { range: selected, island: false }
  if (step.island !== null) {
    const island = new Range()
    island.selectNode(step.island)
    return { range: island, island: true }
  }
  return {
    range: forward ? rangeBetween(node, offset, step.node, step.offset) : rangeBetween(step.node, step.offset, node, offset),
    island: false,
  }
}

function isText(node: Node | null | undefined): node is Text {
  return node !== null && node !== undefined && node.nodeType === TEXT_NODE
}

interface Point {
  node: Node
  offset: number
}

/** Where `text` goes at the point `(container, offset)`: into the Text at it or beside it, else a new Text. */
function insertAt(container: Node, offset: number, text: string): { start: Point; end: Point } {
  if (isText(container)) {
    container.insertData(offset, text)
    return { start: { node: container, offset }, end: { node: container, offset: offset + text.length } }
  }
  const children = container.childNodes
  const before = children[offset - 1]
  if (isText(before)) {
    const at = before.data.length
    before.insertData(at, text)
    return { start: { node: before, offset: at }, end: { node: before, offset: at + text.length } }
  }
  const after = children[offset]
  if (isText(after)) {
    after.insertData(0, text)
    return { start: { node: after, offset: 0 }, end: { node: after, offset: text.length } }
  }
  const created = createTextFor(container, text)
  container.insertBefore(created, after ?? null)
  return { start: { node: created, offset: 0 }, end: { node: created, offset: text.length } }
}

function dispatchInput(host: Element, type: "beforeinput" | "input", inputType: string, data: string | null, isComposing: boolean, targets: StaticRange[]): boolean {
  // Chrome's `beforeinput` of a composition cannot be canceled: the input method has already changed what it shows.
  const cancelable = type === "beforeinput" && inputType !== "insertCompositionText"
  return host.dispatchEvent(
    new InputEvent(type, { bubbles: true, cancelable, composed: true, inputType, data, isComposing, targetRanges: targets })
  )
}

/**
 * One edit of the editing host that holds the selection and focus: `beforeinput`, then the change to
 * the DOM if no listener canceled, then `input`. `data` is the text of an insertion.
 */
export function runEditingInput(inputType: string, data: string | null, options: EditingInputOptions = {}): EditingInputResult {
  const target = editingTarget()
  if (target === null) return NOT_HANDLED
  const host = target.host
  const isComposing = options.isComposing ?? false

  let range: Range
  let removesIsland = false
  switch (inputType) {
    case "insertText":
    case "insertReplacementText":
      range = target.range
      break
    case "insertCompositionText":
      range = options.replacing === undefined ? target.range : options.replacing
      break
    case "deleteContentBackward":
    case "deleteContentForward": {
      const deletion = deletionRange(host, target.range, inputType === "deleteContentForward")
      range = deletion.range
      removesIsland = deletion.island
      break
    }
    default:
      range = target.range
  }

  const targets = [staticRangeOf(range)]
  if (!dispatchInput(host, "beforeinput", inputType, data, isComposing, targets)) {
    return { handled: true, canceled: true, changed: false }
  }
  options.beforeChange?.()

  let caret: Point
  switch (inputType) {
    case "insertText":
    case "insertReplacementText":
    case "insertCompositionText": {
      if (data === null) throw new Error(`${inputType} needs its text`)
      // After the deletion the range sits at the common parent when it spanned two blocks; the caret belongs where the text began.
      const startNode = range.startContainer
      const startOffset = range.startOffset
      range.deleteContents()
      const at = isText(startNode) ? { node: startNode, offset: startOffset } : { node: range.startContainer, offset: range.startOffset }
      const inserted = data === "" ? { start: at, end: at } : insertAt(at.node, at.offset, data)
      if (options.replacing !== undefined) {
        options.replacing.setStart(inserted.start.node, inserted.start.offset)
        options.replacing.setEnd(inserted.end.node, inserted.end.offset)
      }
      caret = inserted.end
      break
    }
    case "deleteContentBackward":
    case "deleteContentForward": {
      if (!removesIsland && range.toString() === "") return { handled: true, canceled: false, changed: false }
      // deleteContents leaves a range over several nodes at their parent; the caret belongs where the removed text began.
      const startNode = range.startContainer
      const startOffset = range.startOffset
      range.deleteContents()
      caret = isText(startNode) ? { node: startNode, offset: startOffset } : { node: range.startContainer, offset: range.startOffset }
      break
    }
    default:
      return { handled: true, canceled: false, changed: false }
  }
  getSelection().collapse(caret.node, caret.offset)
  dispatchInput(host, "input", inputType, data, isComposing, [])
  return { handled: true, canceled: false, changed: true }
}

/** A step of an input method's composition in an editing host. */
export type EditingCompositionStep =
  /** The composition becomes `text`: `compositionstart` on the first, then `compositionupdate`. */
  | { action: "mark"; text: string }
  /** The composition ends with `text` as the final text. */
  | { action: "commit"; text: string }
  /** The composition ends with the text it has. */
  | { action: "unmark" }

interface Composition {
  host: Element
  marked: Range
}

/** By host, so a composition never carries over to another editing host or another window's. */
const compositions = new WeakMap<Element, Composition>()

function dispatchComposition(host: Element, type: string, data: string): void {
  host.dispatchEvent(new CompositionEvent(type, { bubbles: true, composed: true, data }))
}

function startComposition(target: EditingTarget): Composition {
  dispatchComposition(target.host, "compositionstart", target.range.toString())
  const started = { host: target.host, marked: target.range }
  compositions.set(target.host, started)
  return started
}

function replaceMarked(active: Composition, text: string): EditingInputResult {
  return runEditingInput("insertCompositionText", text, {
    isComposing: true,
    replacing: active.marked,
    beforeChange: () => dispatchComposition(active.host, "compositionupdate", text),
  })
}

/**
 * One step of an input method's composition: Chrome's order is `compositionstart`, `beforeinput`,
 * `compositionupdate`, the change, `input`, and at the end `compositionend`. Returns false when
 * no editing host holds the selection and focus.
 */
export function runEditingComposition(step: EditingCompositionStep): boolean {
  const target = editingTarget()
  if (target === null) return false
  if (step.action === "unmark") {
    const ended = compositions.get(target.host)
    if (ended === undefined) return false
    compositions.delete(target.host)
    dispatchComposition(ended.host, "compositionend", ended.marked.toString())
    return true
  }
  const active = compositions.get(target.host) ?? startComposition(target)
  if (step.action === "mark") {
    replaceMarked(active, step.text)
    return true
  }
  if (active.marked.toString() !== step.text) replaceMarked(active, step.text)
  compositions.delete(target.host)
  dispatchComposition(active.host, "compositionend", step.text)
  return true
}
