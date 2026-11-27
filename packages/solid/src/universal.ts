import { createRoot as createSolidRoot, getOwner, type JSX, type Owner } from "solid-js"
import { createRenderer } from "solid-js/universal"
import {
  createHostElement,
  HostRoot,
  createHostText,
  getFirstChild,
  getNextSibling,
  getParentNode,
  insertHostNode,
  isHostNode,
  isHostText,
  isHostPropertyValue,
  removeHostNode,
  replaceHostText,
  setHostProperty,
  type HostElement,
  type HostPropertyValue,
  type HostNode,
  type HostParent,
  type HostText,
} from "./host.js"
import { hasLiveRanges, jsxAttributeOf, jsxAttributeValue, liveRangesReplaceData } from "@ghia/native/host"
import { createSpread } from "./spread.js"
import { notePresenceHost, runInPresenceScope } from "./presence-scope.js"

function isHostRoot(value: unknown): value is HostRoot {
  return value instanceof HostRoot
}

function describe(value: unknown): string {
  return typeof value === "object" && value !== null ? `object ${JSON.stringify(Object.keys(value))}` : String(value)
}

// A component can render any object: solid-refresh passes `{ name }` as a memo's initial value in
// dev, so a component that threw on mount renders that object. `solid-js/universal` keeps what it
// was given in `current` and later reads it back as a position (`getNextSibling(current[i])`, an
// anchor, the node `replaceNode` swaps out), so the object has to be a node to the tree. Each one
// stands for an empty text node that is never visible, and the object itself is never mounted.
// The same object in two places is one node: it moves within a root and cannot be rendered in two roots.
const placeholders = new WeakMap<object, HostText>()

function hostNodeFor(value: unknown): HostNode {
  if (isHostNode(value)) return value
  if (typeof value !== "object" || value === null || isHostRoot(value)) {
    throw new TypeError(`Expected a GPUIX host node, got ${describe(value)}`)
  }
  const existing = placeholders.get(value)
  if (existing) return existing
  console.warn("Unrecognized value. Rendered nothing in its place", value)
  const placeholder = createHostText("")
  placeholders.set(value, placeholder)
  return placeholder
}

/** What a node read (`getParentNode`, `getNextSibling`) is asked about: an object that was never inserted has no neighbours. */
function insertedNodeFor(value: HostNode | HostParent): HostNode | undefined {
  if (isHostNode(value)) return value
  if (isHostRoot(value)) return undefined
  return placeholders.get(value)
}

/** An anchor is a node that was inserted before, so a non-host one without a placeholder is a bug in the caller. */
function anchorNodeFor(anchor: HostNode | HostParent): HostNode {
  const known = insertedNodeFor(anchor)
  if (!known) throw new TypeError(`Expected an anchor that was inserted before, got ${describe(anchor)}`)
  return known
}

/** Web JSX writes `autofocus`, `tabindex` and `for` under the attribute's name; the host reads the props `autoFocus`, `tabIndex` and `htmlFor`. */
function setProperty(node: HostNode | HostParent, name: string, value: unknown, previous: unknown): void {
  if (
    node.kind !== "root" &&
    isHostPropertyValue(value) &&
    isHostPropertyValue(previous)
  ) {
    const attribute = jsxAttributeOf(name)
    if (attribute === undefined) {
      setHostProperty(node, name, value, previous)
      return
    }
    // A conversion keeps the kinds a prop can hold, so the result is still a host property value.
    setHostProperty(node, attribute.prop, jsxAttributeValue(attribute, value) as HostPropertyValue, previous)
  }
}

/** A render into an element that wants to know which nodes it put there: the root owner of its code, and the nodes so far. */
type RenderTracker = { readonly owner: Owner; readonly nodes: Set<HostNode> }

/** The renders in each element they render into, which `insertNode` reports to. Empty for every element no render targets. */
const renderTrackers = new WeakMap<object, Set<RenderTracker>>()

/**
 * A node an effect of a render put directly in the element it renders into belongs to that render, found by the owner chain of
 * the running effect: another render into the same element, a portal of another tree, or the app's own code adds nodes the
 * render does not own, and disposing it must leave those.
 */
function noteInsertedNode(parent: object, node: HostNode): void {
  const trackers = renderTrackers.get(parent)
  if (trackers === undefined) return
  for (let owner = getOwner(); owner !== null; owner = owner.owner) {
    for (const tracker of trackers) {
      if (tracker.owner !== owner) continue
      tracker.nodes.add(node)
      return
    }
  }
}

function noteRemovedNode(parent: object, node: HostNode): void {
  const trackers = renderTrackers.get(parent)
  if (trackers === undefined) return
  for (const tracker of trackers) tracker.nodes.delete(node)
}

const runtime = createRenderer<HostNode | HostParent>({
  createElement: createHostElement,
  createTextNode: createHostText,
  replaceText(node, value) {
    if (!isHostText(node)) throw new TypeError("Expected a GPUIX text node")
    const next = String(value)
    if (hasLiveRanges() && node.text !== next) liveRangesReplaceData(node, 0, node.text.length, next.length)
    replaceHostText(node, next)
  },
  setProperty,
  insertNode(parent, node, anchor) {
    if (parent.kind === "text") throw new TypeError("Expected GPUIX host nodes")
    // Universal passes `null` as the anchor to append (`cleanChildren(parent, current, null, node)`).
    const inserted = hostNodeFor(node)
    insertHostNode(parent, inserted, anchor === undefined || anchor === null ? anchor : anchorNodeFor(anchor))
    noteInsertedNode(parent, inserted)
  },
  isTextNode(node) {
    return isHostNode(node) && isHostText(node)
  },
  removeNode(parent, node) {
    if (parent.kind === "text") throw new TypeError("Expected GPUIX host nodes")
    const known = insertedNodeFor(node)
    if (!known) return
    removeHostNode(parent, known)
    noteRemovedNode(parent, known)
  },
  getParentNode(node) {
    const known = insertedNodeFor(node)
    return known ? getParentNode(known) : undefined
  },
  getFirstChild(node) {
    if (isHostRoot(node)) return getFirstChild(node)
    return isHostNode(node) && node.kind === "element" ? getFirstChild(node) : undefined
  },
  getNextSibling(node) {
    const known = insertedNodeFor(node)
    return known ? getNextSibling(known) : undefined
  },
})

export type UniversalRenderOptions = {
  /** `null` makes the code's nodes go before nothing, so a node already in `body` is kept. */
  marker?: null
  /** What `body` is taken to hold already, as `insert`'s last argument. */
  initial?: JSX.Element
  owner?: Owner | null
  /** Collects the nodes the render puts directly in `body`, the ones it adds later included. */
  owned?: Set<HostNode>
}

// `body` is the parent, not the HostRoot: Solid's `cleanChildren` removes a node only when
// `getParentNode(node)` is the parent it was inserted into, and a top-level node's parent is `body`.
export function universalRender(
  code: () => JSX.Element,
  body: HostNode | HostParent,
  options: UniversalRenderOptions = {}
): () => void {
  return createSolidRoot((dispose) => {
    const owned = options.owned
    const owner = getOwner()
    if (owned === undefined || owner === null) {
      runtime.insert(body, code(), options.marker, options.initial)
      return dispose
    }
    const tracker: RenderTracker = { owner, nodes: owned }
    const trackers = renderTrackers.get(body) ?? new Set<RenderTracker>()
    renderTrackers.set(body, trackers)
    trackers.add(tracker)
    runtime.insert(body, code(), options.marker, options.initial)
    return () => {
      trackers.delete(tracker)
      dispose()
    }
  }, options.owner ?? undefined)
}

export const effect = runtime.effect
export const memo = runtime.memo
export const createComponent: typeof runtime.createComponent = (component, props) =>
  runInPresenceScope(() => runtime.createComponent(component, props))
export const createElement: typeof runtime.createElement = (tag) => {
  const element = runtime.createElement(tag)
  notePresenceHost(element as HostNode)
  return element
}
export const createTextNode = runtime.createTextNode
export const insertNode = runtime.insertNode
export const insert = runtime.insert
export const spread = createSpread<HostNode | HostParent>({ insert: runtime.insert, setProperty })
export const setProp = runtime.setProp
export const mergeProps = runtime.mergeProps
export const use = runtime.use
