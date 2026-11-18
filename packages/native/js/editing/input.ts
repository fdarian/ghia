/**
 * What typing does in an editing host: the `beforeinput` and `input` events of an edit and the
 * change to the DOM between them. The edit goes through the DOM (`insertData`, `deleteContents`), so
 * a `MutationObserver` records it and live ranges and the selection move as they would in Chrome.
 *
 * Phase 1 edits text only. A paragraph or line break fires `beforeinput` and changes nothing; an
 * edit that would join two blocks or remove a `<br>` (a Backspace over a block edge, a word deletion
 * that reaches into the block before) fires `beforeinput` and changes nothing, and text typed over a selection that spans two blocks goes
 * into the block it began in without joining them; an emptied Text node stays in the tree. A
 * Backspace or Delete next to a `contenteditable="false"` element removes it whole. A cut deletes the
 * selection as a Backspace over a selection does, and a paste inserts the text of the clipboard, a
 * `<br>` for each line break.
 */

import type { DataTransfer } from "../dom/data-transfer.js"
import { parseHtmlDocument } from "../dom/html/parse.js"
import { Node, type Element, type Text } from "../dom/nodes.js"
import { createTextFor, Range, StaticRange } from "../dom/range.js"
import { getSelection, holdsNodeSelection } from "../dom/selection.js"
import { crossesBlock, stepPoint } from "../dom/selection-movement.js"
import { CompositionEvent, InputEvent } from "../events/classes.js"
import { document } from "../events/window-target.js"
import { editingHostOf } from "./host.js"
import { moveToLineBoundary } from "./line-movement.js"

const TEXT_NODE = 3
const ELEMENT_NODE = 1
const TEXT_CONTROLS: ReadonlySet<string> = new Set(["input", "textarea"])

export interface EditingInputOptions {
  isComposing?: boolean
  /** The text an `insertCompositionText` replaces, kept by the caller; on return it spans the inserted text. */
  replacing?: Range
  /** Runs after an uncanceled `beforeinput` and before the DOM changes: where `compositionupdate` goes. */
  beforeChange?: () => void
  /** What an `insertFromPaste` inserts, and the `dataTransfer` of its events: a read-only store holding the clipboard. */
  dataTransfer?: DataTransfer
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

/** An `<input>` or `<textarea>`, which edit themselves and take the clipboard commands themselves. */
export function isTextControl(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE && TEXT_CONTROLS.has((node as Element).localName)
}

/** The editing host that has focus, or `null` when focus is elsewhere or on an `<input>` or `<textarea>` (which edit themselves). */
export function focusedEditingHost(): Element | null {
  const focused = focusedNode()
  const host = editingHostOf(focused)
  if (host === null) return null
  if (isTextControl(focused)) return null
  return host
}

/** Whether an editing host that has focus holds the selection, and if so whether it is a caret or a range. */
export function editingSelectionKind(): "none" | "caret" | "range" {
  const target = editingTarget()
  if (target === null) return "none"
  return target.range.collapsed ? "caret" : "range"
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
  /** The range runs over the edge of a block: phase 1 does not join blocks, so the DOM is left as it is. */
  joinsBlocks: boolean
}

interface DeletionKind {
  forward: boolean
  granularity: "character" | "word" | "line"
}

const DELETIONS: Readonly<Record<string, DeletionKind>> = {
  deleteContentBackward: { forward: false, granularity: "character" },
  deleteContentForward: { forward: true, granularity: "character" },
  deleteWordBackward: { forward: false, granularity: "word" },
  deleteWordForward: { forward: true, granularity: "word" },
  deleteSoftLineBackward: { forward: false, granularity: "line" },
  deleteSoftLineForward: { forward: true, granularity: "line" },
}

/**
 * What one deletion removes: the selection, or from the caret one character, one word or to the end
 * of the painted line, or the whole non-editable element the caret is next to. The caret is moved on
 * a copy of the selection's boundary, so `beforeinput` sees the range before anything has changed.
 */
function deletionRange(host: Element, selected: Range, kind: DeletionKind): Deletion {
  const unchanged = { range: selected, island: false, joinsBlocks: false }
  if (!selected.collapsed) return unchanged
  const node = selected.startContainer
  const offset = selected.startOffset
  if (kind.granularity === "line") {
    const moved = moveToLineBoundary(node, offset, kind.forward)
    if (moved === null) return unchanged
    return {
      range: kind.forward ? rangeBetween(node, offset, moved.node, moved.offset) : rangeBetween(moved.node, moved.offset, node, offset),
      island: false,
      joinsBlocks: crossesBlock(host, node, moved.node),
    }
  }
  const step = stepPoint(host, node, offset, kind.forward, kind.granularity)
  if (step === null) return unchanged
  if (step.island !== null) {
    const island = new Range()
    island.selectNode(step.island)
    return { range: island, island: true, joinsBlocks: false }
  }
  return {
    range: kind.forward ? rangeBetween(node, offset, step.node, step.offset) : rangeBetween(step.node, step.offset, node, offset),
    island: false,
    joinsBlocks: crossesBlock(host, node, step.node),
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

/** The text a paste inserts: `text/plain`, else the text content of `text/html`. */
function pastedText(data: DataTransfer): string {
  if (data.types.includes("text/plain")) return data.getData("text/plain")
  if (!data.types.includes("text/html")) return ""
  const body = parseHtmlDocument(data.getData("text/html")).body
  const text = body === null ? null : body.textContent
  if (text === null) throw new Error("A parsed HTML document has no body")
  return text
}

/** A `<br>` at the point, which goes after it: a Text there is split when the point is inside it. */
function insertBreak(at: Point): Point {
  let parent: Node
  let reference: Node | null
  if (isText(at.node)) {
    parent = at.node.parentNode!
    if (at.offset === 0) reference = at.node
    else if (at.offset >= at.node.data.length) reference = at.node.nextSibling
    else reference = at.node.splitText(at.offset)
  } else {
    parent = at.node
    reference = at.node.childNodes[at.offset] ?? null
  }
  const lineBreak = document.createElement("br") as unknown as Node
  parent.insertBefore(lineBreak, reference)
  return { node: parent, offset: [...parent.childNodes].indexOf(lineBreak) + 1 }
}

/** `text` at the point, a `<br>` for each line break; the end of what went in. */
function insertLines(at: Point, text: string): Point {
  let end = at
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) end = insertBreak(end)
    if (line !== "") end = insertAt(end.node, end.offset, line).end
  })
  return end
}

function dispatchInput(
  host: Element,
  type: "beforeinput" | "input",
  inputType: string,
  data: string | null,
  isComposing: boolean,
  targets: StaticRange[],
  dataTransfer: DataTransfer | null = null
): boolean {
  // Chrome's `beforeinput` of a composition cannot be canceled: the input method has already changed what it shows.
  const cancelable = type === "beforeinput" && inputType !== "insertCompositionText"
  return host.dispatchEvent(
    new InputEvent(type, { bubbles: true, cancelable, composed: true, inputType, data, isComposing, dataTransfer, targetRanges: targets })
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
  let joinsBlocks = false
  switch (inputType) {
    case "insertText":
    case "insertReplacementText":
    case "insertFromPaste":
    case "deleteByCut":
      range = target.range
      break
    case "insertCompositionText":
      range = options.replacing === undefined ? target.range : options.replacing
      break
    case "deleteContentBackward":
    case "deleteContentForward":
    case "deleteWordBackward":
    case "deleteWordForward":
    case "deleteSoftLineBackward":
    case "deleteSoftLineForward": {
      const deletion = deletionRange(host, target.range, DELETIONS[inputType]!)
      range = deletion.range
      removesIsland = deletion.island
      joinsBlocks = deletion.joinsBlocks
      break
    }
    default:
      range = target.range
  }

  const dataTransfer = options.dataTransfer ?? null
  const targets = [staticRangeOf(range)]
  if (!dispatchInput(host, "beforeinput", inputType, data, isComposing, targets, dataTransfer)) {
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
    case "insertFromPaste": {
      if (dataTransfer === null) throw new Error("insertFromPaste needs its dataTransfer")
      const startNode = range.startContainer
      const startOffset = range.startOffset
      range.deleteContents()
      const at = isText(startNode) ? { node: startNode, offset: startOffset } : { node: range.startContainer, offset: range.startOffset }
      caret = insertLines(at, pastedText(dataTransfer))
      break
    }
    case "deleteByCut":
    case "deleteContentBackward":
    case "deleteContentForward":
    case "deleteWordBackward":
    case "deleteWordForward":
    case "deleteSoftLineBackward":
    case "deleteSoftLineForward": {
      if (joinsBlocks || (!removesIsland && inputType !== "deleteByCut" && range.toString() === "")) return { handled: true, canceled: false, changed: false }
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
  dispatchInput(host, "input", inputType, data, isComposing, [], dataTransfer)
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

/** What the platform's input method adds to a step: it names the text it replaces and where the caret goes. */
export interface EditingCompositionOptions {
  /** The text the step replaces, in place of the marked text (or the selection, when no composition runs). */
  replacing?: Range
  /** Where the selection goes in the text of a `mark`, as UTF-16 offsets from its start: its end when absent. */
  selected?: readonly [number, number]
}

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

function endComposition(active: Composition, data: string): void {
  compositions.delete(active.host)
  dispatchComposition(active.host, "compositionend", data)
}

/** The text of `marked` is `offset` units in: the selection goes there, in the text the composition put in. */
function selectInMarked(marked: Range, selected: readonly [number, number]): void {
  const node = marked.startContainer
  if (!isText(node)) return
  const at = (offset: number) => Math.min(marked.startOffset + offset, node.data.length)
  getSelection().setBaseAndExtent(node, at(selected[0]), node, at(selected[1]))
}

/**
 * Ends the composition of `host` with the text it has, as `compositionend`: the host lost focus, or the
 * input method began another composition when this one had been dropped. Nothing happens when none runs.
 */
export function endEditingComposition(host: Element): void {
  const running = compositions.get(host)
  if (running !== undefined) endComposition(running, running.marked.toString())
}

/**
 * One step of an input method's composition: Chrome's order is `compositionstart`, `beforeinput`,
 * `compositionupdate`, the change, `input`, and at the end `compositionend`. Marking no text is the
 * input method canceling the composition: the marked text goes, and `compositionend` has no data.
 * Returns false when no editing host holds the selection and focus, or when an `unmark` finds no composition.
 */
export function runEditingComposition(step: EditingCompositionStep, options: EditingCompositionOptions = {}): boolean {
  let target = editingTarget()
  if (target === null) return false
  const running = compositions.get(target.host)
  if (step.action === "unmark") {
    if (running === undefined) return false
    endComposition(running, running.marked.toString())
    return true
  }
  const replacing = options.replacing
  if (replacing !== undefined) {
    if (running !== undefined) {
      running.marked.setStart(replacing.startContainer, replacing.startOffset)
      running.marked.setEnd(replacing.endContainer, replacing.endOffset)
    } else {
      getSelection().setBaseAndExtent(replacing.startContainer, replacing.startOffset, replacing.endContainer, replacing.endOffset)
      target = editingTarget()
      if (target === null) return false
    }
  }
  if (step.action === "mark" && step.text === "") {
    if (running !== undefined) {
      replaceMarked(running, "")
      endComposition(running, "")
    }
    return true
  }
  const active = running ?? startComposition(target)
  if (step.action === "mark") {
    const result = replaceMarked(active, step.text)
    if (result.changed && options.selected !== undefined) selectInMarked(active.marked, options.selected)
    return true
  }
  if (active.marked.toString() !== step.text) replaceMarked(active, step.text)
  // The caret is after what was committed, wherever in the marked text the input method had put it.
  if (active.marked.endContainer.isConnected) getSelection().collapse(active.marked.endContainer, active.marked.endOffset)
  endComposition(active, step.text)
  return true
}
