/**
 * Text the platform's input handler gives a focused editing host: typed characters, a dead key's
 * result (a one-character composition), an input method's composition, the emoji picker, dictation.
 * Native cannot edit a DOM, so its handler sends one internal `editinput` event per edit
 * (`src/editing/input_handler.rs`), and this runs it as the browser would: `beforeinput`, the change,
 * `input` (`runEditingInput`), or the step of a composition (`runEditingComposition`). It flushes the
 * mutations before it returns, so that the next question the platform asks (the selection after an
 * insert) is answered from the new tree.
 *
 * It is not a DOM event: no listener hears it, and it is handled whether or not anything listens.
 */

import type { EventPayload } from "../../index.js"
import { flushPendingMutations } from "../bounds.js"
import { DOM_BINDING, type Element, type Node, type Text, type TextBinding } from "../dom/nodes.js"
import { Range } from "../dom/range.js"
import { getSelection } from "../dom/selection.js"
import type { NativeRenderer } from "../host.js"
import { isEditingHost } from "./host.js"
import { endEditingComposition, runEditingComposition, runEditingInput } from "./input.js"

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

function rangeBetween(points: [TextPoint, TextPoint]): Range {
  const range = new Range()
  range.setStart(points[0].node, points[0].offset)
  range.setEnd(points[1].node, points[1].offset)
  return range
}

/** The replacement range the platform named, as DOM positions in `host`, or `undefined` when the edit goes where the selection is. */
function replacementRange(host: Element, event: EventPayload): [TextPoint, TextPoint] | undefined {
  const range = event.editRange
  if (range == null) return undefined
  if (range.length !== 4) throw new Error(`An editinput range has four numbers, not ${range.length}`)
  return [pointIn(host, range[0]!, range[1]!), pointIn(host, range[2]!, range[3]!)]
}

function selectedRange(event: EventPayload): [number, number] | undefined {
  const selected = event.editSelection
  if (selected == null) return undefined
  if (selected.length !== 2) throw new Error(`An editinput selection has two numbers, not ${selected.length}`)
  return [selected[0]!, selected[1]!]
}

/**
 * Runs the edit `event` asks for. `isComposing` says whether the platform's composition was running
 * when it asked: JS keeps its own (the `compositionstart` it sent and the marked text as a live range),
 * and a composition the platform has dropped, a click that moved the caret out of it, is ended before
 * the next edit begins another.
 *
 * - `insert` with a composition running is its commit: the text replaces the marked text and
 *   `compositionend` follows. Without one it is `insertText`, or `insertReplacementText` over a range.
 * - `mark` is a step of a composition: `compositionstart` the first time, `beforeinput`,
 *   `compositionupdate`, the change, `input`, then the selection where the input method put it.
 * - `unmark` ends the composition with the text it has marked.
 */
export function runNativeEditInput(event: EventPayload, host: Element, renderer: NativeRenderer): void {
  const range = replacementRange(host, event)
  const composing = event.isComposing === true
  if (!composing) endEditingComposition(host)
  switch (event.inputType) {
    case "insert": {
      if (event.data == null) throw new Error("An editinput insert arrived without its text")
      if (composing) {
        runEditingComposition({ action: "commit", text: event.data }, { replacing: range && rangeBetween(range) })
      } else {
        if (range !== undefined) {
          getSelection().setBaseAndExtent(range[0].node, range[0].offset, range[1].node, range[1].offset)
        }
        const replaces = range !== undefined && (range[0].node !== range[1].node || range[0].offset !== range[1].offset)
        runEditingInput(replaces ? "insertReplacementText" : "insertText", event.data)
      }
      break
    }
    case "mark":
      if (event.data == null) throw new Error("An editinput mark arrived without its text")
      runEditingComposition({ action: "mark", text: event.data }, { replacing: range && rangeBetween(range), selected: selectedRange(event) })
      break
    case "unmark":
      runEditingComposition({ action: "unmark" })
      break
    default:
      throw new Error(`An editinput of kind ${String(event.inputType)} is not one this version knows`)
  }
  flushPendingMutations(renderer)
}

/**
 * A host that loses focus ends the composition it has (`compositionend`, before `blur`), as Chrome
 * does: native ended the platform's side when focus left, and Lexical and its like wait for the event.
 */
export function endCompositionOnBlur(element: object | undefined): void {
  if (element === undefined) return
  if (isEditingHost(element as Element)) endEditingComposition(element as Element)
}
