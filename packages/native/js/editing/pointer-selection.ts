/**
 * What a press, a drag and a release of the primary button do in an editing host: the caret goes where the
 * pointer is, a drag extends the selection, a double click selects the word and a triple click the
 * block, and a drag that went on from either extends by words or blocks.
 *
 * Native finds the DOM position under the pointer in the painted text and sends one internal
 * `editpointer` event per phase (`src/editing/pointer.rs`); this is the `Selection` half. It is not a DOM
 * event: no listener hears it, and it runs only when `mousedown` was not prevented, which native
 * decides. The flush at the end sends the selection to native, so the wash and the caret follow.
 */

import { flushPendingMutations } from "../bounds.js"
import type { EventPayload } from "../../index.js"
import { DOM_BINDING, indexOfNode, type Element, type ElementBinding, type Node, type Text } from "../dom/nodes.js"
import { enclosingBlock } from "../dom/selection-movement.js"
import { getSelection, holdsNodeSelection } from "../dom/selection.js"
import { wordAt } from "../dom/text-segmentation.js"
import { comparePoints, isInclusiveAncestor } from "../dom/tree-order.js"
import type { NativeRenderer } from "../host.js"
import { editingHostOf, ownContentEditable } from "./host.js"
import { textById } from "./native-input.js"

export const EDIT_POINTER_EVENT = "editpointer"

const TEXT_NODE = 3
const ELEMENT_NODE = 1

interface Place {
  node: Node
  offset: number
}

/** What a click count selects at a place: the place itself (a caret), a word or a block. */
interface Unit {
  start: Place
  end: Place
}

type Granularity = "caret" | "word" | "block"

interface Drag {
  host: Element
  granularity: Granularity
  anchor: Unit
}

/** The press that is down. One pointer, so one drag, whichever window it is in. */
let drag: Drag | null = null

/** The outermost `contenteditable="false"` element above `node` inside `host`, or `null` when `node` is editable text. */
function islandAround(host: Element, node: Node): Element | null {
  let island: Element | null = null
  for (let parent = node.parentNode; parent !== null && parent !== host; parent = parent.parentNode) {
    if (ownContentEditable(parent as Element) === "false") island = parent as Element
  }
  return island
}

/** The element of `root`'s subtree, `root` included, that native knows as `id`: the block of an empty line. */
function elementById(root: Element, id: number): Element | null {
  if ((root[DOM_BINDING]() as ElementBinding).native?.id === id) return root
  for (const child of root.childNodes) {
    if (child.nodeType !== ELEMENT_NODE) continue
    const found = elementById(child as Element, id)
    if (found !== null) return found
  }
  return null
}

function placeOf(host: Element, event: EventPayload): Place {
  const range = event.editRange
  // A host that paints no text has no place under the pointer but its own start.
  if (range == null) return { node: host, offset: 0 }
  if (range.length !== 4) throw new Error(`An editpointer position has four numbers, not ${range.length}`)
  const offset = range[1]!
  const node = textById(host, range[0]!)
  if (node === null) {
    // An empty line paints no text: native names its block, at the offset before its line break.
    const block = elementById(host, range[0]!)
    if (block === null) throw new Error(`The pointer named node ${range[0]}, which the editing host does not have`)
    return { node: block, offset }
  }
  // Text of an island that sits in a paragraph is painted with the rest of it, and no caret goes inside it:
  // it goes to the side of the island the point is nearer.
  const island = islandAround(host, node)
  if (island === null) return { node, offset }
  const parent = island.parentNode as Node
  const after = offset * 2 >= node.data.length
  return { node: parent, offset: indexOfNode(island) + (after ? 1 : 0) }
}

function unitAt(host: Element, place: Place, granularity: Granularity): Unit {
  const collapsed = { start: place, end: place }
  if (granularity === "caret" || place.node === host) return collapsed
  if (granularity === "word") {
    if (place.node.nodeType !== TEXT_NODE) return collapsed
    const word = wordAt((place.node as Text).data, place.offset)
    if (word === undefined) return collapsed
    return { start: { node: place.node, offset: word[0] }, end: { node: place.node, offset: word[1] } }
  }
  const block = enclosingBlock(place.node, host)
  return { start: { node: block, offset: 0 }, end: { node: block, offset: block.childNodes.length } }
}

/** The selection from the unit the press began in to the unit under the pointer, in the direction the pointer went. */
function selectBetween(anchor: Unit, focus: Unit): void {
  const backwards = comparePoints(focus.start.node, focus.start.offset, anchor.start.node, anchor.start.offset) < 0
  const from = backwards ? anchor.end : anchor.start
  const to = backwards ? focus.start : focus.end
  getSelection().setBaseAndExtent(from.node, from.offset, to.node, to.offset)
}

function granularityOf(clickCount: number): Granularity {
  if (clickCount <= 1) return "caret"
  return clickCount === 2 ? "word" : "block"
}

/** The anchor of the selection when it is a range in `host`: what Shift+click extends from. */
function anchorIn(host: Element): Place | null {
  if (!holdsNodeSelection()) return null
  const selection = getSelection()
  const node = selection.anchorNode
  if (node === null || editingHostOf(node) !== host) return null
  return { node, offset: selection.anchorOffset }
}

function press(host: Element, event: EventPayload): void {
  const granularity = granularityOf(event.detail ?? 1)
  const place = placeOf(host, event)
  const extended = granularity === "caret" && event.shiftKey === true ? anchorIn(host) : null
  const anchor: Unit = extended === null ? unitAt(host, place, granularity) : { start: extended, end: extended }
  drag = { host, granularity, anchor }
  selectBetween(anchor, extended === null ? anchor : unitAt(host, place, granularity))
}

function extend(held: Drag, event: EventPayload): void {
  // A tree change took the text the press began in: there is nothing to extend from.
  if (!isInclusiveAncestor(held.host, held.anchor.start.node) || !isInclusiveAncestor(held.host, held.anchor.end.node)) {
    drag = null
    return
  }
  selectBetween(held.anchor, unitAt(held.host, placeOf(held.host, event), held.granularity))
}

/**
 * Runs the phase `event` names. `host` is the element it is aimed at, `undefined` when it left the tree after native
 * sent the event, which ends the drag.
 */
export function runEditingPointer(event: EventPayload, host: Element | undefined, renderer: NativeRenderer): void {
  if (host === undefined) {
    drag = null
    return
  }
  switch (event.inputType) {
    case "down":
      press(host, event)
      break
    case "drag":
      if (drag !== null && drag.host === host) extend(drag, event)
      break
    case "up":
      drag = null
      break
    default:
      throw new Error(`An editpointer of phase ${String(event.inputType)} is not one this version knows`)
  }
  flushPendingMutations(renderer)
}
