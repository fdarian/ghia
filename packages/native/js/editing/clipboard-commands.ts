/**
 * Copy, cut, paste and select all as a browser does them when the user asks: the key, or the Edit
 * menu. Native sends one internal `clipboardcommand` event (`src/events/clipboard.rs`) when no text
 * control took the command, and this fires the DOM clipboard event ("fire a clipboard event" in the
 * Clipboard API) and, if nothing canceled it, does what Chrome does. It answers whether it did the
 * command: a copy that is not handled falls back to the painted-text selection, which only native
 * holds. Cut and paste have no such fallback and are always handled.
 *
 * It is not a DOM event itself: no listener hears it.
 */

import { dataTransferControl, DataTransfer } from "../dom/data-transfer.js"
import { serializeChildren } from "../dom/html/parse.js"
import { rangeInnerText } from "../dom/inner-text.js"
import { Node, type Element } from "../dom/nodes.js"
import { holdsNodeSelection } from "../dom/selection.js"
import { ClipboardEvent } from "../events/classes.js"
import { documentOf, type GpuixDocument } from "../events/window-target.js"
import type { ClipboardData } from "../../index.js"
import { flushPendingMutations } from "../bounds.js"
import type { NativeRenderer } from "../host.js"
import { setDocumentCommands } from "./document-commands.js"
import { editingHostOf } from "./host.js"
import { editingSelectionKind, focusedNode, isTextControl, pastedText, runEditingInput } from "./input.js"

export const CLIPBOARD_COMMAND_EVENT = "clipboardcommand"

export type ClipboardCommand = "copy" | "cut" | "paste" | "selectAll"

/** What asked for the command: the key or the Edit menu, or a `document.execCommand` call. */
export type ClipboardCommandSource = "user" | "exec"

const ELEMENT_NODE = 1

interface ClipboardAccess {
  writeClipboard(items: ClipboardData[]): void
  readClipboard(): ClipboardData[]
}

function clipboardOf(renderer: NativeRenderer): ClipboardAccess {
  if (!renderer.writeClipboard || !renderer.readClipboard) {
    throw new Error("This renderer has no clipboard")
  }
  return renderer as ClipboardAccess
}

export function isClipboardCommand(name: string | undefined): name is ClipboardCommand {
  return name === "copy" || name === "cut" || name === "paste" || name === "selectAll"
}

/**
 * Where the event goes: the element that holds the start of the selection, and the focused element
 * (`body` when nothing has focus) when there is no selection. Chrome's `FindEventTargetFrom` takes the
 * selection's start whether or not it is editable, so a selection that code put on a hidden element
 * (Lexical's node selection) is what the event is aimed at while an editing host has focus.
 */
function eventTarget(document: GpuixDocument): Element {
  const selection = document.getSelection()
  if (holdsNodeSelection(selection)) {
    if (selection.rangeCount > 0) {
      const start = selection.getRangeAt(0).startContainer
      const element = start.nodeType === ELEMENT_NODE ? (start as Element) : start.parentElement
      if (element !== null) return element
    }
  }
  return focusedNode(document) as Element
}

/** Dispatches the event and says whether a handler canceled it. */
function fire(type: "copy" | "cut" | "paste", target: Element, data: DataTransfer): boolean {
  const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, composed: true, clipboardData: data })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

/** The string items of `data`, in order, as the pasteboard takes them. Files are not written. */
function stringEntries(data: DataTransfer): ClipboardData[] {
  const entries: ClipboardData[] = []
  for (const type of data.types) {
    if (type === "Files") continue
    entries.push({ type, data: data.getData(type) })
  }
  return entries
}

/**
 * The "write content to the clipboard" step of a canceled `copy` or `cut`: what the handler put in
 * `clipboardData` replaces the clipboard. With nothing in it the clipboard is left alone, unless the
 * handler cleared the data (`clearData()` or `items.clear()` and no write since), which clears the
 * clipboard, or only the types it named.
 */
function writeCanceled(data: DataTransfer, clipboard: ClipboardAccess): void {
  const entries = stringEntries(data)
  if (entries.length > 0) {
    clipboard.writeClipboard(entries)
    return
  }
  const control = dataTransferControl(data)
  if (!control.clearWasCalled) return
  if (control.typesToClear.length === 0) {
    clipboard.writeClipboard([])
    return
  }
  const cleared = new Set(control.typesToClear)
  clipboard.writeClipboard(clipboard.readClipboard().filter((entry) => !cleared.has(entry.type)))
}

/**
 * Chrome's own copy of the node selection: its text, with a line break between blocks and at a `<br>`
 * (`rangeInnerText`; `Selection.toString` has none), and its markup under a `<meta charset>`. False
 * when there is none.
 */
function copyNodeSelection(document: GpuixDocument, clipboard: ClipboardAccess): boolean {
  const selection = document.getSelection()
  if (!holdsNodeSelection(selection)) return false
  if (selection.isCollapsed) return false
  const markup = serializeChildren(selection.getRangeAt(0).cloneContents())
  clipboard.writeClipboard([
    { type: "text/plain", data: rangeInnerText(selection.getRangeAt(0)) },
    { type: "text/html", data: `<meta charset='utf-8'>${markup}` },
  ])
  return true
}

/** `copy` and `cut` hand the handler a store it may write, and the clipboard gets what it wrote when it cancels. */
function fireWritable(document: GpuixDocument, type: "copy" | "cut", clipboard: ClipboardAccess): boolean {
  const data = new DataTransfer()
  const control = dataTransferControl(data)
  const canceled = fire(type, eventTarget(document), data)
  try {
    if (canceled) writeCanceled(data, clipboard)
  } finally {
    control.mode = "protected"
  }
  return canceled
}

function runCopy(document: GpuixDocument, clipboard: ClipboardAccess): boolean {
  if (fireWritable(document, "copy", clipboard)) return true
  return copyNodeSelection(document, clipboard)
}

/**
 * Chrome's default cut: in an editing host, a range is copied and then deleted (`beforeinput`
 * `deleteByCut`, so the clipboard has it even when a listener cancels the deletion). Anywhere else, or
 * with a caret, Chrome does nothing, so this is handled and has no painted-text fallback. A cut that
 * `execCommand` asked for fires no `beforeinput` (Input Events: it is not a user's edit), only `input`.
 */
function runCut(document: GpuixDocument, clipboard: ClipboardAccess, source: ClipboardCommandSource): boolean {
  if (fireWritable(document, "cut", clipboard)) return true
  if (editingSelectionKind(document) !== "range") return true
  copyNodeSelection(document, clipboard)
  runEditingInput(document, "deleteByCut", null, { beforeInput: source === "user" })
  return true
}

/** A fresh store of the clipboard's items in the mode `beforeinput` of a paste has: read-only. */
function clipboardData(clipboard: ClipboardAccess, mode: "readonly" | "protected"): DataTransfer {
  const data = new DataTransfer()
  const control = dataTransferControl(data)
  for (const entry of clipboard.readClipboard()) data.setData(entry.type, entry.data)
  control.mode = mode
  return data
}

/**
 * Chrome's default paste: the text of the clipboard goes into an editing host at the selection, and
 * anywhere else nothing does. A clipboard with no text changes nothing, and fires no `beforeinput`.
 */
function runPaste(document: GpuixDocument, clipboard: ClipboardAccess): boolean {
  const data = clipboardData(clipboard, "readonly")
  let canceled: boolean
  try {
    canceled = fire("paste", eventTarget(document), data)
  } finally {
    dataTransferControl(data).mode = "protected"
  }
  if (canceled) return true
  if (editingSelectionKind(document) === "none") return true
  const items = clipboardData(clipboard, "readonly")
  if (pastedText(items) === null) return true
  runEditingInput(document, "insertFromPaste", null, { dataTransfer: items })
  return true
}

/** Cmd+A: the focused editing host's contents, or the page's when none has focus. */
function runSelectAll(document: GpuixDocument): boolean {
  const host = editingHostOf(focusedNode(document))
  const body: unknown = document.body
  if (!(body instanceof Node)) throw new Error("document.body is not a DOM node")
  document.getSelection().selectAllChildren(host ?? body)
  return true
}

/**
 * Runs `command` and returns whether it was done, so that native does not do its own. Nothing runs
 * when an `<input>` or `<textarea>` has focus: it handles the command itself, and fires no
 * clipboard event (docs/fork/deviations.md).
 */
export function runClipboardCommand(command: ClipboardCommand, renderer: NativeRenderer, source: ClipboardCommandSource = "user"): boolean {
  const document = documentOf(renderer)
  if (isTextControl(focusedNode(document))) return false
  const clipboard = clipboardOf(renderer)
  let handled: boolean
  switch (command) {
    case "copy":
      handled = runCopy(document, clipboard)
      break
    case "cut":
      handled = runCut(document, clipboard, source)
      break
    case "paste":
      handled = runPaste(document, clipboard)
      break
    case "selectAll":
      handled = runSelectAll(document)
      break
  }
  flushPendingMutations(renderer)
  return handled
}

const EXEC_COMMANDS: Readonly<Record<string, ClipboardCommand | undefined>> = {
  copy: "copy",
  cut: "cut",
  selectall: "selectAll",
}

function documentCommandOf(name: string): ClipboardCommand | undefined {
  return EXEC_COMMANDS[name.toLowerCase()]
}

/**
 * `document.execCommand("copy")` and `("cut")` run the clipboard command at once, so the `copy` or
 * `cut` event fires inside the call, as Chrome fires it during a user gesture; user activation is not
 * tracked. `"paste"` does nothing, as in Chrome without the clipboard-read permission.
 */
setDocumentCommands({
  exec(document, name) {
    const command = documentCommandOf(name)
    if (command === undefined) return false
    return runClipboardCommand(command, document.window.requireRenderer(`document.execCommand("${name}")`), "exec")
  },
  supported(name) {
    return documentCommandOf(name) !== undefined || name.toLowerCase() === "paste"
  },
  enabled(document, name) {
    switch (name.toLowerCase()) {
      case "copy":
        return holdsNodeSelection(document.getSelection()) && !document.getSelection().isCollapsed
      case "cut":
        return editingSelectionKind(document) === "range"
      case "selectall":
        return true
      default:
        return false
    }
  },
})
