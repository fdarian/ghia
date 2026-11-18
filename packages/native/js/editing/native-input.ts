/**
 * Text the platform's input handler gives a focused editing host: typed characters, a dead key's
 * result, the emoji picker, dictation. Native cannot edit a DOM, so its handler sends one internal
 * `editinput` event per edit (`src/editing/input_handler.rs`), and this runs it as the browser would:
 * `beforeinput`, the change, `input` (`runEditingInput`), then it flushes the mutations before it
 * returns, so that the next question the platform asks (the selection after an insert) is answered from
 * the new tree.
 *
 * It is not a DOM event: no listener hears it, and it is handled whether or not anything listens.
 */

import type { EventPayload } from "../../index.js"
import { flushPendingMutations } from "../bounds.js"
import { DOM_BINDING, type Element, type Node, type Text, type TextBinding } from "../dom/nodes.js"
import { getSelection } from "../dom/selection.js"
import type { NativeRenderer } from "../host.js"
import { runEditingInput } from "./input.js"

export const EDIT_INPUT_EVENT = "editinput"

const ELEMENT_NODE = 1
const TEXT_NODE = 3

interface TextPoint {
  node: Text
  offset: number
}

function textById(root: Node, id: number): Text | null {
  for (const child of root.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      if ((child[DOM_BINDING]() as TextBinding).native?.id === id) return child as Text
    } else if (child.nodeType === ELEMENT_NODE) {
      const found = textById(child, id)
      if (found !== null) return found
    }
  }
  return null
}

function pointIn(host: Element, id: number, offset: number): TextPoint {
  const node = textById(host, id)
  if (node === null) {
    throw new Error(`The text input named text node ${id}, which the editing host does not have`)
  }
  return { node, offset }
}

/** The replacement range the platform named, as DOM positions in `host`, or `undefined` when the edit goes where the selection is. */
function replacementRange(host: Element, event: EventPayload): [TextPoint, TextPoint] | undefined {
  const range = event.editRange
  if (range == null) return undefined
  if (range.length !== 4) throw new Error(`An editinput range has four numbers, not ${range.length}`)
  return [pointIn(host, range[0]!, range[1]!), pointIn(host, range[2]!, range[3]!)]
}

/**
 * Runs the edit `event` asks for. `mark` and `unmark` (an input method's composition) are not edits
 * of the DOM yet: they are ignored.
 */
export function runNativeEditInput(event: EventPayload, host: Element, renderer: NativeRenderer): void {
  switch (event.inputType) {
    case "insert": {
      if (event.data == null) throw new Error("An editinput insert arrived without its text")
      const range = replacementRange(host, event)
      if (range !== undefined) {
        getSelection().setBaseAndExtent(range[0].node, range[0].offset, range[1].node, range[1].offset)
      }
      const replaces = range !== undefined && (range[0].node !== range[1].node || range[0].offset !== range[1].offset)
      runEditingInput(replaces ? "insertReplacementText" : "insertText", event.data)
      flushPendingMutations(renderer)
      return
    }
    case "mark":
    case "unmark":
      return
    default:
      throw new Error(`An editinput of kind ${String(event.inputType)} is not one this version knows`)
  }
}
