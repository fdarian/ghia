/**
 * What the keys that move the caret, extend the selection or delete by a word or a line do in a
 * focused editing host, as the default action of an unprevented `keydown`.
 *
 * The table is Chrome's on macOS: Blink's own (`editing_behavior.cc`) is not what runs there, because
 * the browser process turns the key into an AppKit command first (`StandardKeyBinding.dict`) and the
 * renderer executes that command. Where the two disagree this follows the commands. What is left out,
 * and why, is in docs/fork/editing.md.
 */

import type { Element } from "../dom/nodes.js"
import { getSelection, holdsNodeSelection } from "../dom/selection.js"
import type { DomEvent } from "../events/dispatch.js"
import { editingHostOf } from "./host.js"
import { focusedEditingHost, runEditingInput } from "./input.js"

type Granularity = "character" | "word" | "line" | "lineboundary" | "documentboundary"

type Binding =
  | { action: "move"; alter: "move" | "extend"; forward: boolean; granularity: Granularity }
  | { action: "delete"; inputType: string }
  | { action: "selectAll" }

function move(forward: boolean, granularity: Granularity, extend: boolean): Binding {
  return { action: "move", alter: extend ? "extend" : "move", forward, granularity }
}

/**
 * The binding of a keydown, or `null` when the key is not one: Home and End scroll on macOS (the
 * scroll keys' default), Option+Up and Down move by paragraph, and Control+Arrow belongs to the system.
 */
function bindingOf(event: DomEvent): Binding | null {
  const modifiers = event.modifiers
  const shift = Boolean(modifiers?.shift)
  const alt = Boolean(modifiers?.alt)
  const ctrl = Boolean(modifiers?.ctrl)
  const cmd = Boolean(modifiers?.cmd)
  const plain = !alt && !ctrl && !cmd
  const key = event.key
  if (key === undefined) return null

  switch (key) {
    case "ArrowLeft":
    case "ArrowRight": {
      const forward = key === "ArrowRight"
      if (ctrl || (alt && cmd)) return null
      if (cmd) return move(forward, "lineboundary", shift)
      return move(forward, alt ? "word" : "character", shift)
    }
    case "ArrowUp":
    case "ArrowDown": {
      const forward = key === "ArrowDown"
      if (ctrl || alt) return null
      return move(forward, cmd ? "documentboundary" : "line", shift)
    }
    case "Home":
    case "End":
      // Shift+Home is moveToBeginningOfDocumentAndModifySelection. Home alone is scrollToBeginningOfDocument.
      return plain && shift ? move(key === "End", "documentboundary", true) : null
    case "Backspace":
      if (alt && !cmd) return { action: "delete", inputType: "deleteWordBackward" }
      if (cmd && !alt && !ctrl) return { action: "delete", inputType: "deleteSoftLineBackward" }
      return null
    case "Delete":
      return alt && !cmd ? { action: "delete", inputType: "deleteWordForward" } : null
  }

  if (cmd && !alt && !ctrl) return key === "a" && !shift ? { action: "selectAll" } : null

  // The Emacs bindings of the text system: Control alone, and Control+Shift for the extending moves.
  if (ctrl && !alt && !cmd) {
    switch (key.toLowerCase()) {
      case "b":
        return move(false, "character", shift)
      case "f":
        return move(true, "character", shift)
      case "p":
        return move(false, "line", shift)
      case "n":
        return move(true, "line", shift)
      case "h":
        return shift ? null : { action: "delete", inputType: "deleteContentBackward" }
      case "d":
        return shift ? null : { action: "delete", inputType: "deleteContentForward" }
    }
  }
  return null
}

/** Whether the selection is a range in `host`, which is what a move or a deletion works on. */
function selectionIsIn(host: Element): boolean {
  if (!holdsNodeSelection()) return false
  const selection = getSelection()
  return (
    selection.anchorNode !== null &&
    selection.focusNode !== null &&
    editingHostOf(selection.anchorNode) === host &&
    editingHostOf(selection.focusNode) === host
  )
}

/**
 * Performs the binding of `event` in the focused editing host. Returns true when the key was one of
 * them, so that the platform adds nothing and the scroll keys do not move the page under the caret.
 */
export function runKeyBinding(event: DomEvent): boolean {
  // A key the input method is composing with is the input method's.
  if (event.isComposing) return false
  const binding = bindingOf(event)
  if (binding === null) return false
  const host = focusedEditingHost()
  if (host === null) return false

  if (binding.action === "selectAll") {
    // The select-all of the editing host, not of the document.
    getSelection().selectAllChildren(host)
    return true
  }
  if (!selectionIsIn(host)) return false
  if (binding.action === "delete") return runEditingInput(binding.inputType, null).handled
  getSelection().modify(binding.alter, binding.forward ? "forward" : "backward", binding.granularity)
  return true
}
