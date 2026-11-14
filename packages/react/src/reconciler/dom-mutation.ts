/// Changes to a React root's tree made by code that is not React: `document.createElement`,
/// `appendChild`, `remove`, `textContent = ...`. They go through the same mirror
/// (`linkChild`/`unlinkChild`), native calls and `MutationObserver` records as React's own
/// placements, so a node React made and a node code made sit in one tree.

import {
  attributesWritten,
  crossRootError,
  forwardsCustomProp,
  hasMutationObservers,
  queueCharacterDataMutation,
  recordAttributeChanges,
  runAll,
  serializeCustomProp,
} from "@ghia/native/host"
import type { DomNodeFactory, StyleDesc, Text } from "@ghia/native/host"
import type { Container, ElementType, Instance, TextInstance } from "../types/host.js"
import { adopt, assertPlacement, markUnmounted, materialize, nextId, sendLiveStyle } from "./host-config.js"
import {
  containerFor,
  createHostElement,
  createHostText,
  isInTree,
  linkChild,
  propOf,
  stateFor,
  unlinkChild,
  type HostNode,
} from "./host-nodes.js"

/**
 * Nodes taken out of the tree by code, whose native element is released at the next flush
 * unless they are in the document again by then. Keyed by the window's `<html>`, which every
 * container of a window (a portal's included) shares.
 */
const detachedByWindow = new WeakMap<Instance, Set<HostNode>>()

function detachedOf(container: Container): Set<HostNode> {
  const existing = detachedByWindow.get(container.html)
  if (existing) return existing
  const created = new Set<HostNode>()
  detachedByWindow.set(container.html, created)
  return created
}

export function createDomFactory(container: Container): DomNodeFactory {
  return {
    createElement: (type) => createDomElement(container, type),
    createTextNode: (data) => createDomText(container, data) as unknown as Text,
  }
}

export function createDomElement(container: Container, type: string): Instance {
  return createHostElement(nextId(container), type as ElementType, {}, container)
}

export function createDomText(container: Container, data: string): TextInstance {
  return createHostText(nextId(container), data, container)
}

export function assertSameWindow(parent: Instance, child: HostNode): void {
  if (containerFor(child).nativeRenderer !== stateFor(parent).container.nativeRenderer) throw crossRootError()
}

/**
 * Places `child` in `parent` before `before`, or last, as `insertBefore` does. A node that is in
 * the document is moved natively, not made again.
 */
export function insertDomNode(parent: Instance, child: HostNode, before: HostNode | null): void {
  assertSameWindow(parent, child)
  const parentState = stateFor(parent)
  const container = parentState.container
  assertPlacement(parent, child)
  adopt(parent, child)
  linkChild(parent, child, before ?? undefined)
  if (!parentState.mounted) {
    // The parent has no native element (code made it, or native released it), so what is moved
    // into it leaves native's tree too.
    retire(child)
    return
  }
  materialize(child)
  detachedOf(container).delete(child)
  if (before === null) container.renderer.appendChild(parent.nativeId, child.nativeId)
  else container.renderer.insertBefore(parent.nativeId, child.nativeId, before.nativeId)
}

/**
 * Takes `child` out of `parent`. Native lets the element go, with what is in it, at the next
 * flush, unless the node is in the document again by then: code keeps what it removes.
 */
export function removeDomNode(parent: Instance, child: HostNode): void {
  unlinkChild(child)
  adopt(undefined, child)
  retire(child)
}

function retire(node: HostNode): void {
  const state = stateFor(node)
  if (!state.mounted) return
  const container = state.container
  detachedOf(container).add(node)
  // Native is told now: a layout read before the flush must not lay out what the DOM took out.
  container.renderer.detachChild(node.nativeId)
  container.renderer.requestFlush()
}

/** Releases the native elements of the nodes code took out of the document and did not put back, each one even when another throws. */
export function releaseDetachedNodes(container: Container): void {
  const detached = detachedByWindow.get(container.html)
  if (detached === undefined || detached.size === 0) return
  const nodes = [...detached]
  detached.clear()
  runAll(nodes, (node) => {
    const state = stateFor(node)
    if (!state.mounted || isInTree(node)) return
    // If markUnmounted throws partway, the descendants it did not reach keep `mounted = true` while
    // their native element is destroyed: accepted, the alternative is leaking the native tree.
    try {
      markUnmounted(node)
    } finally {
      state.container.renderer.destroyElement(node.nativeId)
    }
  }, "Releasing detached nodes failed")
}

export function setDomTextData(text: TextInstance, data: string): void {
  if (text.text === data) return
  const previous = text.text
  text.text = data
  queueCharacterDataMutation(text, previous)
  const state = stateFor(text)
  if (state.mounted) state.container.renderer.setText(text.nativeId, data)
}

/**
 * Code's write of the whole style of an element: it is the live style from now on, and native is
 * sent it as it is sent React's own style change.
 */
export function setDomStyle(instance: Instance, next: StyleDesc): void {
  const state = stateFor(instance)
  const apply = () => {
    state.codeStyle = next
  }
  if (hasMutationObservers()) recordAttributeChanges(instance, ["style"], apply)
  else apply()
  // A burst of writes (a drag writing the transform on every pointer move) is one `setStyle` for the next flush.
  // The element may have been released, or React may have sent this style, by the time the flush runs it.
  if (state.mounted) {
    state.container.renderer.deferWrite(instance, () => {
      if (state.mounted) sendLiveStyle(instance, state)
    })
  }
}

/** Code's write of one prop (`el.id = ...`): React's next render of the same prop overwrites it. */
export function setDomProp(instance: Instance, name: string, value: string | number | boolean | undefined): void {
  const state = stateFor(instance)
  const apply = () => {
    state.propOverrides ??= new Map()
    state.propOverrides.set(name, value)
  }
  if (hasMutationObservers()) recordAttributeChanges(instance, [name], apply)
  else apply()
  if (state.mounted && forwardsCustomProp(instance.elementType, name)) {
    state.container.renderer.setCustomProp(instance.nativeId, name, serializeCustomProp(value))
  }
  if (state.mounted) {
    // The attribute store natively reads is the one a framework prop writes, so a code write goes there too.
    for (const [attribute, text] of attributesWritten(instance.elementType, name, value, (prop) => propOf(instance, prop))) {
      state.container.renderer.setAttribute(instance.nativeId, attribute, text)
    }
  }
  // A write from code is applied before the call returns: `setAttribute` reads the element's state at once.
  if (state.mounted) state.container.renderer.flushMutations()
}

