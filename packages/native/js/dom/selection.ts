import { editingHostOf } from "../editing/host.js"
import { mountedRenderer } from "../mounted-renderer.js"
import { namedError } from "../named-error.js"
import type { NativeRenderer } from "../host.js"
import type { RangeBoundaries } from "./live-ranges.js"
import { Node, type Element, type Text } from "./nodes.js"
import { boundariesOf, Range, StaticRange } from "./range.js"
import { moveByLine, moveToDocumentBoundary, moveToLineBoundary, type MovedPosition } from "../editing/line-movement.js"
import { movePoint } from "./selection-movement.js"
import type { MovementGranularity } from "./text-segmentation.js"
import { childCount, comparePoints, isInclusiveAncestor, nodeLength } from "./tree-order.js"

const DOCUMENT_NODE = 9
const DOCUMENT_TYPE_NODE = 10
const TEXT_NODE = 3

/** What the document tells the selection about, and what the selection asks of the document. */
export interface SelectionHooks {
  /** Whether a `selectionchange` listener exists on `document` or `window`. */
  listens(): boolean
  /** Sends `selectionchange` to `document`. */
  dispatch(): void
  /** The selection began or stopped holding a node range: native's painted-selection events are wanted while it does. */
  heldChanged(): void
}

type Direction = "forwards" | "backwards"
const GRANULARITIES: ReadonlySet<string> = new Set([
  "character",
  "word",
  "sentence",
  "line",
  "paragraph",
  "lineboundary",
  "sentenceboundary",
  "paragraphboundary",
  "documentboundary",
])

/** What `modify` can do: the rest of `GRANULARITIES` are names the standard has and this does not do yet. */
const SUPPORTED: ReadonlySet<string> = new Set(["character", "word", "line", "lineboundary", "documentboundary"])

const INTERNAL = {
  hooks: Symbol.for("@ghia/native/selection-hooks"),
  holds: Symbol.for("@ghia/native/selection-holds"),
  painted: Symbol.for("@ghia/native/selection-painted"),
  caret: Symbol.for("@ghia/native/selection-caret"),
} as const

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


function inDocument(node: Node): boolean {
  return node.getRootNode().nodeType === DOCUMENT_NODE
}

function assertNodeArgument(value: unknown, method: string, position: number): asserts value is Node {
  if (!(value instanceof Node)) {
    throw new TypeError(`Failed to execute '${method}' on 'Selection': parameter ${position} is not of type 'Node'.`)
  }
}

/** The checks every method that names a boundary point makes, in the order the spec runs them. */
function assertBoundary(node: Node, offset: number): void {
  if (node.nodeType === DOCUMENT_TYPE_NODE) {
    throw namedError("InvalidNodeTypeError", "The node is a DocumentType, which a selection cannot be in.")
  }
  if (offset > nodeLength(node)) throw namedError("IndexSizeError", "The offset is larger than the node's length.")
}

function firstTextIn(root: Node): Text | null {
  for (const child of root.childNodes) {
    if (child.nodeType === TEXT_NODE) return child as Text
    const found = firstTextIn(child)
    if (found !== null) return found
  }
  return null
}

/**
 * The selection of the window that mounted last, shaped like the DOM's `Selection`.
 *
 * It is one of two things. After code selects nodes (`setBaseAndExtent`, `collapse`, `addRange`,
 * `selectAllChildren`, `modify`, or `focus()` on an editing host) it holds a live `Range` over the
 * DOM and answers everything from it. Otherwise it reports the spans of text the user painted by
 * dragging, which are not nodes, so only what they can answer is here: whether anything is selected,
 * the selected text, and clearing it. The two never exist together: a node selection clears the
 * painted one, and a painted one clears the node range.
 *
 * The `Range` is the selection's own, as in the standard and in Chrome: `getRangeAt()` returns it,
 * `addRange(range)` makes `range` it, and changing it (`setStart`, `collapse`, `deleteContents`, a
 * tree change that moves one of its points) changes the selection and queues `selectionchange`. A
 * method of the selection that sets the selection anew (`collapse()`, `setBaseAndExtent()`, ...)
 * does not change a `Range` already handed out: that one stops being the selection's.
 */
abstract class SelectionClass {
  #range: Range | null = null
  #direction: Direction = "forwards"
  /** Code holds `#range` (`getRangeAt` or `addRange` gave it out), so the selection sets itself anew with another one. */
  #shared = false
  #changePending = false
  #hooks: SelectionHooks | undefined
  readonly #rangeChanged = (): void => {
    this.#goalX = null
    this.#queueChange()
  }
  /**
   * The window x that consecutive `modify` moves by line keep, so a caret that went through a short
   * line comes back to its column. Any other change of the selection forgets it.
   */
  #goalX: number | null = null

  constructor(token?: symbol) {
    if (token !== CREATE) throw new TypeError("Illegal constructor")
  }

  get #own(): { range: Range; bounds: RangeBoundaries } | null {
    return this.#range === null ? null : { range: this.#range, bounds: boundariesOf(this.#range) }
  }

  get anchorNode(): Node | null {
    const own = this.#own
    if (own === null) return null
    return this.#direction === "forwards" ? own.bounds.startNode : own.bounds.endNode
  }

  get anchorOffset(): number {
    const own = this.#own
    if (own === null) return 0
    return this.#direction === "forwards" ? own.bounds.startOffset : own.bounds.endOffset
  }

  get focusNode(): Node | null {
    const own = this.#own
    if (own === null) return null
    return this.#direction === "forwards" ? own.bounds.endNode : own.bounds.startNode
  }

  get focusOffset(): number {
    const own = this.#own
    if (own === null) return 0
    return this.#direction === "forwards" ? own.bounds.endOffset : own.bounds.startOffset
  }

  /** `none` while collapsed, as Chrome answers, and with no node range. */
  get direction(): "none" | Direction {
    const own = this.#own
    if (own === null || own.range.collapsed) return "none"
    return this.#direction
  }

  /** 1 while a node range or any painted text is selected, 0 otherwise. */
  get rangeCount(): number {
    if (this.#range !== null) return 1
    return selectedText("Selection.rangeCount") === null ? 0 : 1
  }

  get isCollapsed(): boolean {
    if (this.#range !== null) return this.#range.collapsed
    return selectedText("Selection.isCollapsed") === null
  }

  /** `Caret` for a collapsed node range. Painted text has no caret, so it is `Range` or `None`. */
  get type(): "None" | "Caret" | "Range" {
    if (this.#range !== null) return this.#range.collapsed ? "Caret" : "Range"
    return selectedText("Selection.type") === null ? "None" : "Range"
  }

  toString(): string {
    if (this.#range !== null) return this.#range.toString()
    return selectedText("Selection.toString") ?? ""
  }

  getRangeAt(index: number): Range {
    if (this.#range === null) {
      if (this.rangeCount === 0) throw namedError("IndexSizeError", "This selection has no range.")
      throw namedError("NotSupportedError", "The selection is painted text, which is not a Range of nodes.")
    }
    if (index >>> 0 !== 0) throw namedError("IndexSizeError", "The selection has one range: index 0.")
    this.#shared = true
    return this.#range
  }

  /** Does nothing while a node range exists, as Chrome does. A painted selection gives way. */
  addRange(range: Range): void {
    if (!(range instanceof Range)) {
      throw new TypeError("Failed to execute 'addRange' on 'Selection': parameter 1 is not of type 'Range'.")
    }
    if (this.#range !== null) return
    if (!inDocument(range.startContainer)) return
    this.#clearPainted()
    this.#hold(range)
    this.#shared = true
    this.#direction = "forwards"
    this.#hooks?.heldChanged()
    this.#queueChange()
  }

  removeRange(range: Range): void {
    if (!(range instanceof Range)) {
      throw new TypeError("Failed to execute 'removeRange' on 'Selection': parameter 1 is not of type 'Range'.")
    }
    if (this.#range === null || range !== this.#range) {
      throw namedError("NotFoundError", "The range is not the range of this selection.")
    }
    this.#drop(true)
  }

  /** Clears the node range and any painted text. */
  removeAllRanges(): void {
    if (this.#range !== null) {
      this.#drop(true)
      this.#clearPainted()
      return
    }
    const renderer = currentRenderer("Selection.removeAllRanges")
    if (renderer.clearSelection === undefined) {
      throw new Error("This renderer cannot clear the text selection, so Selection.removeAllRanges is unavailable")
    }
    renderer.clearSelection()
  }

  empty(): void {
    this.removeAllRanges()
  }

  /** `node` null clears the selection. */
  collapse(node: Node | null, offset: number = 0): void {
    if (node === null) {
      this.removeAllRanges()
      return
    }
    assertNodeArgument(node, "collapse", 1)
    const point = offset >>> 0
    assertBoundary(node, point)
    if (!inDocument(node)) return
    this.#assign(node, point, node, point, "forwards")
  }

  setPosition(node: Node | null, offset: number = 0): void {
    this.collapse(node, offset)
  }

  collapseToStart(): void {
    const own = this.#requireOwn("collapseToStart")
    this.#assign(own.bounds.startNode, own.bounds.startOffset, own.bounds.startNode, own.bounds.startOffset, "forwards")
  }

  collapseToEnd(): void {
    const own = this.#requireOwn("collapseToEnd")
    this.#assign(own.bounds.endNode, own.bounds.endOffset, own.bounds.endNode, own.bounds.endOffset, "forwards")
  }

  /** Moves the focus to `(node, offset)`; the anchor stays. */
  extend(node: Node, offset: number = 0): void {
    assertNodeArgument(node, "extend", 1)
    const point = offset >>> 0
    const own = this.#requireOwn("extend")
    assertBoundary(node, point)
    if (!inDocument(node)) return
    this.#extendTo(node, point, own.bounds)
  }

  setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number): void {
    assertNodeArgument(anchorNode, "setBaseAndExtent", 1)
    assertNodeArgument(focusNode, "setBaseAndExtent", 3)
    const anchorPoint = anchorOffset >>> 0
    const focusPoint = focusOffset >>> 0
    assertBoundary(anchorNode, anchorPoint)
    assertBoundary(focusNode, focusPoint)
    if (!inDocument(anchorNode) || !inDocument(focusNode)) return
    if (comparePoints(anchorNode, anchorPoint, focusNode, focusPoint) <= 0) {
      this.#assign(anchorNode, anchorPoint, focusNode, focusPoint, "forwards")
    } else {
      this.#assign(focusNode, focusPoint, anchorNode, anchorPoint, "backwards")
    }
  }

  selectAllChildren(node: Node): void {
    assertNodeArgument(node, "selectAllChildren", 1)
    assertBoundary(node, 0)
    if (!inDocument(node)) return
    this.#assign(node, 0, node, childCount(node), "forwards")
  }

  /** Whether `node` is inside the selection: all of it, or with `allowPartialContainment` any part of it. */
  containsNode(node: Node, allowPartialContainment: boolean = false): boolean {
    assertNodeArgument(node, "containsNode", 1)
    const own = this.#own
    if (own === null || !inDocument(node)) return false
    const length = nodeLength(node)
    const bounds = own.bounds
    if (allowPartialContainment) {
      return (
        comparePoints(node, 0, bounds.endNode, bounds.endOffset) <= 0 &&
        comparePoints(node, length, bounds.startNode, bounds.startOffset) >= 0
      )
    }
    return (
      comparePoints(node, 0, bounds.startNode, bounds.startOffset) >= 0 &&
      comparePoints(node, length, bounds.endNode, bounds.endOffset) <= 0
    )
  }

  /** Removes the selected nodes and text from the tree. A painted selection is text, not nodes, so it stays. */
  deleteFromDocument(): void {
    const own = this.#own
    if (own === null) return
    own.range.deleteContents()
  }

  /** A `StaticRange` of the node range, or none. There is no shadow DOM here, so no shadow root changes it. */
  getComposedRanges(..._shadowRoots: unknown[]): StaticRange[] {
    const own = this.#own
    if (own === null) return []
    return [
      new StaticRange({
        startContainer: own.bounds.startNode,
        startOffset: own.bounds.startOffset,
        endContainer: own.bounds.endNode,
        endOffset: own.bounds.endOffset,
      }),
    ]
  }

  /**
   * Moves or extends the selection by a `character`, a `word`, a `line`, to the `lineboundary` or
   * the `documentboundary`, in the text under the editing host the focus is in, or the document.
   * `left` and `right` read as `backward` and `forward`. Arguments the standard has no name for do
   * nothing, as in Chrome; `sentence`, `paragraph` and their boundaries throw `NotSupportedError`.
   * Moves by line keep the x of the caret across consecutive calls.
   */
  modify(alter: string, direction: string, granularity: string): void {
    const alterKey = String(alter).toLowerCase()
    const directionKey = String(direction).toLowerCase()
    const granularityKey = String(granularity).toLowerCase()
    if (alterKey !== "move" && alterKey !== "extend") return
    if (!["forward", "backward", "left", "right"].includes(directionKey)) return
    if (!GRANULARITIES.has(granularityKey)) return
    if (!SUPPORTED.has(granularityKey)) {
      throw namedError("NotSupportedError", `Selection.modify("${granularityKey}") is not supported yet.`)
    }
    const own = this.#own
    if (own === null) return
    const forward = directionKey === "forward" || directionKey === "right"
    const bounds = own.bounds

    if (alterKey === "extend") {
      const focus = this.#direction === "forwards"
        ? { node: bounds.endNode, offset: bounds.endOffset }
        : { node: bounds.startNode, offset: bounds.startOffset }
      const moved = this.#moved(focus.node, focus.offset, forward, granularityKey)
      if (moved !== null) {
        this.#extendTo(moved.node, moved.offset, bounds)
        this.#goalX = moved.goalX
      }
      return
    }

    const collapsed = own.range.collapsed
    // Chrome ends a range at its edge on the first character step instead of stepping past it.
    const from = forward
      ? { node: bounds.endNode, offset: bounds.endOffset }
      : { node: bounds.startNode, offset: bounds.startOffset }
    if (!collapsed && granularityKey === "character") {
      this.#assign(from.node, from.offset, from.node, from.offset, "forwards")
      return
    }
    const moved = this.#moved(from.node, from.offset, forward, granularityKey)
    if (moved !== null) {
      this.#assign(moved.node, moved.offset, moved.node, moved.offset, "forwards")
      this.#goalX = moved.goalX
    }
  }

  #moved(node: Node, offset: number, forward: boolean, granularity: string): MovedPosition | null {
    const host = editingHostOf(node)
    const scope = host === null ? node.getRootNode() : host
    switch (granularity) {
      case "line":
        return moveByLine(scope, node, offset, forward, this.#goalX)
      case "lineboundary":
        return moveToLineBoundary(node, offset, forward)
      case "documentboundary":
        return moveToDocumentBoundary(scope, forward)
      default: {
        const moved = movePoint(scope, node, offset, forward, granularity as MovementGranularity)
        return moved === null ? null : { node: moved.node, offset: moved.offset, goalX: null }
      }
    }
  }

  #requireOwn(method: string): { range: Range; bounds: RangeBoundaries } {
    const own = this.#own
    if (own === null) {
      throw namedError(
        "InvalidStateError",
        `Selection.${method}() needs a range of nodes, and this selection has none.`
      )
    }
    return own
  }

  /** The standard's `extend` steps: the focus goes to the point, the anchor stays. */
  #extendTo(node: Node, offset: number, bounds: RangeBoundaries): void {
    const anchorNode = this.#direction === "forwards" ? bounds.startNode : bounds.endNode
    const anchorOffset = this.#direction === "forwards" ? bounds.startOffset : bounds.endOffset
    if (anchorNode.getRootNode() !== node.getRootNode()) {
      this.#assign(node, offset, node, offset, "forwards")
    } else if (comparePoints(anchorNode, anchorOffset, node, offset) <= 0) {
      this.#assign(anchorNode, anchorOffset, node, offset, "forwards")
    } else {
      this.#assign(node, offset, anchorNode, anchorOffset, "backwards")
    }
  }

  /** Makes the node range `(start, end)`, which clears painted text and, if anything changed, queues `selectionchange`. */
  #assign(
    startNode: Node,
    startOffset: number,
    endNode: Node,
    endOffset: number,
    direction: Direction
  ): void {
    this.#goalX = null
    const held = this.#range !== null
    const current = this.#range === null ? null : boundariesOf(this.#range)
    const changed =
      current === null ||
      current.startNode !== startNode ||
      current.startOffset !== startOffset ||
      current.endNode !== endNode ||
      current.endOffset !== endOffset ||
      this.#direction !== direction
    // Painted text appears only while no node range is held (native then tells `paintedSelectionTookOver`), so one check, as the range begins, is enough.
    if (!held) this.#clearPainted()
    if (changed) {
      // A range code holds is not moved from under it: a new one is the selection.
      if (this.#range === null || this.#shared) this.#hold(new Range())
      const bounds = boundariesOf(this.#range as Range)
      bounds.startNode = startNode
      bounds.startOffset = startOffset
      bounds.endNode = endNode
      bounds.endOffset = endOffset
    }
    this.#direction = direction
    if (!held) this.#hooks?.heldChanged()
    if (changed) this.#queueChange()
  }

  /** Makes `range` the selection's range, which tells the selection of every change to it; the range it had stops doing so. */
  #hold(range: Range): void {
    this.#release()
    this.#range = range
    this.#goalX = null
    this.#shared = false
    boundariesOf(range).onAdjust = this.#rangeChanged
  }

  /** The selection stops listening to its range. A range that was dropped still adjusts to the tree, but it is no longer the selection. */
  #release(): void {
    if (this.#range !== null) boundariesOf(this.#range).onAdjust = undefined
  }

  /** Forgets the node range. `announce` queues `selectionchange`; a painted selection that replaces it announces itself. */
  #drop(announce: boolean): void {
    if (this.#range === null) return
    this.#release()
    this.#range = null
    this.#goalX = null
    this.#shared = false
    this.#direction = "forwards"
    this.#hooks?.heldChanged()
    if (announce) this.#queueChange()
  }

  /** Painted text and a node range are exclusive, so a new node range removes what was painted. */
  #clearPainted(): void {
    const renderer = mountedRenderer()
    if (renderer?.getSelectedText === undefined || renderer.clearSelection === undefined) return
    if (renderer.getSelectedText() !== null) renderer.clearSelection()
  }

  /**
   * One `selectionchange` per burst of changes, in a task of its own. A listener added after the
   * change and before the task runs hears it, so the task is queued whether or not one listens now.
   */
  #queueChange(): void {
    if (this.#changePending || this.#hooks === undefined) return
    this.#changePending = true
    setTimeout(() => {
      this.#changePending = false
      if (this.#hooks?.listens()) this.#hooks.dispatch()
    }, 0)
  }

  [INTERNAL.hooks](hooks: SelectionHooks): void {
    this.#hooks = hooks
  }

  [INTERNAL.holds](): boolean {
    return this.#range !== null
  }

  [INTERNAL.painted](): void {
    this.#drop(false)
  }

  [INTERNAL.caret](host: Element): void {
    const own = this.#own
    if (own !== null && isInclusiveAncestor(host, own.bounds.startNode) && isInclusiveAncestor(host, own.bounds.endNode)) {
      return
    }
    const text = firstTextIn(host)
    const node: Node = text === null ? host : text
    this.#assign(node, 0, node, 0, "forwards")
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

/** Tells the selection how to reach `document`: see `SelectionHooks`. */
export function setSelectionHooks(hooks: SelectionHooks): void {
  const instance = shared.instance as unknown as Record<symbol, (hooks: SelectionHooks) => void>
  instance[INTERNAL.hooks](hooks)
}

/** Whether the selection holds a node range, which a painted selection replaces. */
export function holdsNodeSelection(): boolean {
  return (shared.instance as unknown as Record<symbol, () => boolean>)[INTERNAL.holds]()
}

/** Native painted text is selected now: the node range, if any, gives way to it. */
export function paintedSelectionTookOver(): void {
  ;(shared.instance as unknown as Record<symbol, () => void>)[INTERNAL.painted]()
}

/** `element.focus()` on an editing host: a collapsed caret at the first position of the host unless the selection is already in it. */
export function placeCaretInEditingHost(host: Element): void {
  ;(shared.instance as unknown as Record<symbol, (host: Element) => void>)[INTERNAL.caret](host)
}
