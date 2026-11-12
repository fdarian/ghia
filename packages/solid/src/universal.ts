import { createRoot as createSolidRoot, type JSX } from "solid-js"
import { createRenderer } from "solid-js/universal"
import {
  createHostElement,
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
  type HostRoot,
} from "./host.js"
import { notePresenceHost, runInPresenceScope } from "./presence-scope.js"

function isHostRoot(value: unknown): value is HostRoot {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "root"
}

function describe(value: unknown): string {
  return typeof value === "object" && value !== null ? `object ${JSON.stringify(Object.keys(value))}` : String(value)
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
    // Like solid-js/web, which skips an object that is not a DOM node: a component can render any
    // object (solid-refresh passes `{ name }` as a memo's initial value, so a component that
    // throws on mount renders that). Mounting it would leave a half-mounted node in the tree.
    if (!isHostNode(node)) {
      console.warn("Unrecognized value. Skipped inserting", node)
      return
    }
    if (parent.kind === "text") throw new TypeError("Expected GPUIX host nodes")
    // Universal passes `null` as the anchor to append (`cleanChildren(parent, current, null, node)`).
    if (anchor !== undefined && anchor !== null && !isHostNode(anchor)) {
      throw new TypeError(`Expected a GPUIX host node as the insertion anchor, got ${describe(anchor)}`)
    }
    insertHostNode(parent, node, anchor)
  },
  isTextNode(node) {
    return isHostNode(node) && isHostText(node)
  },
  removeNode(parent, node) {
    // A skipped value was never inserted.
    if (!isHostNode(node)) return
    if (parent.kind === "text") throw new TypeError("Expected GPUIX host nodes")
    removeHostNode(parent, node)
  },
  getParentNode(node) {
    return isHostNode(node) ? getParentNode(node) : undefined
  },
  getFirstChild(node) {
    if (isHostRoot(node)) return getFirstChild(node)
    return isHostNode(node) && node.kind === "element" ? getFirstChild(node) : undefined
  },
  getNextSibling(node) {
    return isHostNode(node) ? getNextSibling(node) : undefined
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
