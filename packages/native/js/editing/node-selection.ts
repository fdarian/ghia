/**
 * The selection of nodes, sent to the native root that owns it so that it can be painted (the wash
 * over the selected text).
 *
 * Native reads two boundary points and the editing host of a caret (`setNodeSelection`, last op of a
 * batch). The batch carries what the selection is when the queue flushes, not each step it took to get
 * there: `takeNodeSelectionWrite` compares the selection with what the root was last sent, so a flush
 * that finds no change sends nothing, and a selection that moved to another root clears the one it left.
 * A change outside a framework commit asks the queues concerned for a flush, so it is painted by the next
 * frame like a style written from code.
 */

import { requestMutationFlush } from "../bounds.js"
import { DOM_BINDING, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { getSelection, holdsNodeSelection, subscribeNodeSelection } from "../dom/selection.js"
import type { NativeRenderer } from "../host.js"
import { editingHostOf } from "./host.js"
import type { WireNodeSelection } from "../wire.js"

const ELEMENT_NODE = 1
const TEXT_NODE = 3

interface Sent {
  /** What each root holds now, by the text `keyOf` makes of it; a root that holds nothing has no entry. */
  keys: WeakMap<object, string>
  /** The roots that hold a selection, to clear the one the selection left. */
  holders: Set<WeakRef<NativeRenderer>>
}

const SENT_KEY = Symbol.for("@ghia/native/node-selection-sent")

/** Shared through `globalThis` like the selection itself, so a second copy of this package agrees on what was sent. */
function sent(): Sent {
  const existing = Reflect.get(globalThis, SENT_KEY) as Sent | undefined
  if (existing) return existing
  const created: Sent = { keys: new WeakMap(), holders: new Set() }
  Reflect.set(globalThis, SENT_KEY, created)
  return created
}

function nativeOf(node: Node): { renderer: NativeRenderer; id: number } | undefined {
  if (node.nodeType !== ELEMENT_NODE && node.nodeType !== TEXT_NODE) return undefined
  return (node[DOM_BINDING]() as ElementBinding | TextBinding).native
}

/** The wire's `hostId` for a selection that is not the caret of an editing host. */
const NO_HOST = 0

/** The id of the editing host the caret `focusNode` is in, `NO_HOST` for a selection that is not one. */
function hostIdOf(selection: ReturnType<typeof getSelection>, focusNode: Node): number {
  if (!selection.isCollapsed) return NO_HOST
  const host = editingHostOf(focusNode)
  if (host === null) return NO_HOST
  const hostNative = nativeOf(host)
  // The host is above a node that is mounted, so it is mounted too.
  if (hostNative === undefined) throw new Error("The editing host of a mounted node is not mounted")
  return hostNative.id
}

/** The selection as the root `renderer` is to hold it: both ends in it, or `null`. */
function wantedBy(renderer: NativeRenderer): WireNodeSelection | null {
  if (!holdsNodeSelection()) return null
  const selection = getSelection()
  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  if (anchorNode === null || focusNode === null) return null
  const anchor = nativeOf(anchorNode)
  const focus = nativeOf(focusNode)
  if (anchor === undefined || focus === undefined || anchor.renderer !== renderer || focus.renderer !== renderer) {
    return null
  }
  return {
    anchorId: anchor.id,
    anchorOffset: selection.anchorOffset,
    focusId: focus.id,
    focusOffset: selection.focusOffset,
    hostId: hostIdOf(selection, focusNode),
  }
}

function keyOf(selection: WireNodeSelection | null): string {
  if (selection === null) return ""
  return `${selection.anchorId}:${selection.anchorOffset}:${selection.focusId}:${selection.focusOffset}:${selection.hostId}`
}

/**
 * What a flush of the queue of `renderer` has to write: the selection when it is not what the root holds,
 * `null` to clear what it holds, `undefined` when the root is up to date.
 */
export function takeNodeSelectionWrite(renderer: NativeRenderer): WireNodeSelection | null | undefined {
  const state = sent()
  const known = state.keys.get(renderer)
  if (known === undefined && !holdsNodeSelection()) return undefined
  const wanted = wantedBy(renderer)
  const key = keyOf(wanted)
  if (known === undefined ? key === "" : known === key) return undefined
  if (wanted === null) {
    state.keys.delete(renderer)
    for (const holder of state.holders) {
      const held = holder.deref()
      if (held === undefined || held === renderer) state.holders.delete(holder)
    }
  } else {
    state.keys.set(renderer, key)
    if (![...state.holders].some((holder) => holder.deref() === renderer)) state.holders.add(new WeakRef(renderer))
  }
  return wanted
}

/** The selection changed: the root it is in, and the roots that hold an older one, are to send it. */
function selectionChanged(): void {
  const state = sent()
  const roots = new Set<NativeRenderer>()
  for (const holder of state.holders) {
    const held = holder.deref()
    if (held === undefined) state.holders.delete(holder)
    else roots.add(held)
  }
  if (holdsNodeSelection()) {
    const anchorNode = getSelection().anchorNode
    const owner = anchorNode === null ? undefined : nativeOf(anchorNode)?.renderer
    if (owner !== undefined) roots.add(owner)
  }
  for (const root of roots) requestMutationFlush(root)
}

subscribeNodeSelection(selectionChanged)
