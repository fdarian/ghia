import { createRoot as createSolidRoot, type JSX } from "solid-js"
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
  type HostNode,
  type HostParent,
  type HostText,
} from "./host.js"
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

const runtime = createRenderer<HostNode | HostParent>({
  createElement: createHostElement,
  createTextNode: createHostText,
  replaceText(node, value) {
    if (!isHostText(node)) throw new TypeError("Expected a GPUIX text node")
    replaceHostText(node, value)
  },
  setProperty(node, name, value, previous) {
    if (
      node.kind !== "root" &&
      isHostPropertyValue(value) &&
      isHostPropertyValue(previous)
    ) {
      setHostProperty(node, name, value, previous)
    }
  },
  insertNode(parent, node, anchor) {
    if (parent.kind === "text") throw new TypeError("Expected GPUIX host nodes")
    // Universal passes `null` as the anchor to append (`cleanChildren(parent, current, null, node)`).
    insertHostNode(parent, hostNodeFor(node), anchor === undefined || anchor === null ? anchor : anchorNodeFor(anchor))
  },
  isTextNode(node) {
    return isHostNode(node) && isHostText(node)
  },
  removeNode(parent, node) {
    if (parent.kind === "text") throw new TypeError("Expected GPUIX host nodes")
    const known = insertedNodeFor(node)
    if (known) removeHostNode(parent, known)
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

// `body` is the parent, not the HostRoot: Solid's `cleanChildren` removes a node only when
// `getParentNode(node)` is the parent it was inserted into, and a top-level node's parent is `body`.
export function universalRender(code: () => JSX.Element, body: HostElement): () => void {
  return createSolidRoot((dispose) => {
    runtime.insert(body, code())
    return dispose
  })
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
export const spread = runtime.spread
export const setProp = runtime.setProp
export const mergeProps = runtime.mergeProps
export const use = runtime.use
