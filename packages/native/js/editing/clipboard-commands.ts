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
import { Node, type Element } from "../dom/nodes.js"
import { getSelection, holdsNodeSelection } from "../dom/selection.js"
import { ClipboardEvent } from "../events/classes.js"
import { document } from "../events/window-target.js"
import type { ClipboardData } from "../../index.js"
import { flushPendingMutations } from "../bounds.js"
import type { NativeRenderer } from "../host.js"
import { mountedRenderer } from "../mounted-renderer.js"
import { setDocumentCommands } from "./document-commands.js"
import { editingHostOf } from "./host.js"
import { editingSelectionKind, focusedNode, isTextControl, runEditingInput } from "./input.js"

export const CLIPBOARD_COMMAND_EVENT = "clipboardcommand"

export type ClipboardCommand = "copy" | "cut" | "paste" | "selectAll"

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
function eventTarget(): Element {
  if (holdsNodeSelection()) {
    const selection = getSelection()
    if (selection.rangeCount > 0) {
      const start = selection.getRangeAt(0).startContainer
      const element = start.nodeType === ELEMENT_NODE ? (start as Element) : start.parentElement
      if (element !== null) return element
    }
  }
  return focusedNode() as Element
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

/** Chrome's own copy of the node selection: its text, and its markup under a `<meta charset>`. False when there is none. */
function copyNodeSelection(clipboard: ClipboardAccess): boolean {
  if (!holdsNodeSelection()) return false
  const selection = getSelection()
  if (selection.isCollapsed) return false
  const markup = serializeChildren(selection.getRangeAt(0).cloneContents())
  clipboard.writeClipboard([
    { type: "text/plain", data: selection.toString() },
    { type: "text/html", data: `<meta charset='utf-8'>${markup}` },
  ])
  return true
}

/** `copy` and `cut` hand the handler a store it may write, and the clipboard gets what it wrote when it cancels. */
function fireWritable(type: "copy" | "cut", clipboard: ClipboardAccess): boolean {
  const data = new DataTransfer()
  const control = dataTransferControl(data)
  const canceled = fire(type, eventTarget(), data)
  try {
    if (canceled) writeCanceled(data, clipboard)
  } finally {
    control.mode = "protected"
  }
  return canceled
}

function runCopy(clipboard: ClipboardAccess): boolean {
  if (fireWritable("copy", clipboard)) return true
  return copyNodeSelection(clipboard)
}

/**
 * Chrome's default cut: in an editing host, a range is copied and then deleted (`beforeinput`
 * `deleteByCut`, so the clipboard has it even when a listener cancels the deletion). Anywhere else, or
 * with a caret, Chrome does nothing, so this is handled and has no painted-text fallback.
 */
function runCut(clipboard: ClipboardAccess): boolean {
  if (fireWritable("cut", clipboard)) return true
  if (editingSelectionKind() !== "range") return true
  copyNodeSelection(clipboard)
  runEditingInput("deleteByCut", null)
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

/** Chrome's default paste: the text of the clipboard goes into an editing host at the selection, and anywhere else nothing does. */
function runPaste(clipboard: ClipboardAccess): boolean {
  const data = clipboardData(clipboard, "readonly")
  let canceled: boolean
  try {
    canceled = fire("paste", eventTarget(), data)
  } finally {
    dataTransferControl(data).mode = "protected"
  }
  if (canceled) return true
  if (editingSelectionKind() === "none") return true
  runEditingInput("insertFromPaste", null, { dataTransfer: clipboardData(clipboard, "readonly") })
  return true
}

/** Cmd+A: the focused editing host's contents, or the page's when none has focus. */
function runSelectAll(): boolean {
  const host = editingHostOf(focusedNode())
  const body: unknown = document.body
  if (!(body instanceof Node)) throw new Error("document.body is not a DOM node")
  getSelection().selectAllChildren(host ?? body)
  return true
}

/**
 * Runs `command` and returns whether it was done, so that native does not do its own. Nothing runs
 * when an `<input>` or `<textarea>` has focus: it handles the command itself, and fires no
 * clipboard event (docs/fork/deviations.md).
 */
export function runClipboardCommand(command: ClipboardCommand, renderer: NativeRenderer): boolean {
  if (isTextControl(focusedNode())) return false
  const clipboard = clipboardOf(renderer)
  let handled: boolean
  switch (command) {
    case "copy":
      handled = runCopy(clipboard)
      break
    case "cut":
      handled = runCut(clipboard)
      break
    case "paste":
      handled = runPaste(clipboard)
      break
    case "selectAll":
      handled = runSelectAll()
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
  exec(name) {
    const command = documentCommandOf(name)
    if (command === undefined) return false
    const renderer = mountedRenderer()
    if (renderer === undefined) throw new Error(`document.execCommand("${name}") needs a mounted GPUIX root. Call it after render().`)
    return runClipboardCommand(command, renderer)
  },
  supported(name) {
    return documentCommandOf(name) !== undefined || name.toLowerCase() === "paste"
  },
  enabled(name) {
    switch (name.toLowerCase()) {
      case "copy":
        return holdsNodeSelection() && !getSelection().isCollapsed
      case "cut":
        return editingSelectionKind() === "range"
      case "selectall":
        return true
      default:
        return false
    }
  },
})
