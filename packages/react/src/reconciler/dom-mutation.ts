/// Changes to a React root's tree made by code that is not React: `document.createElement`,
/// `appendChild`, `remove`, `textContent = ...`. They go through the same mirror
/// (`linkChild`/`unlinkChild`), native calls and `MutationObserver` records as React's own
/// placements, so a node React made and a node code made sit in one tree.

import { crossRootError, queueCharacterDataMutation } from "@ghia/native/host"
import type { DomNodeFactory, Text } from "@ghia/native/host"
import type { Container, ElementType, Instance, TextInstance } from "../types/host.js"
import { adopt, assertPlacement, markUnmounted, materialize, nextId } from "./host-config.js"
import {
  containerFor,
  createHostElement,
  createHostText,
  isInTree,
  linkChild,
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
    createElement: (type) => createHostElement(nextId(container), type as ElementType, {}, container),
    createTextNode: (data) => createDomText(container, data) as unknown as Text,
  }
}

export function createDomText(container: Container, data: string): TextInstance {
  return createHostText(nextId(container), data, container)
}

/**
 * Places `child` in `parent` before `before`, or last, as `insertBefore` does. A node that is in
 * the document is moved natively, not made again.
 */
export function insertDomNode(parent: Instance, child: HostNode, before: HostNode | null): void {
  const parentState = stateFor(parent)
  const container = parentState.container
  if (containerFor(child).nativeRenderer !== container.nativeRenderer) throw crossRootError()
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

/** Releases the native elements of the nodes code took out of the document and did not put back. */
export function releaseDetachedNodes(container: Container): void {
  const detached = detachedByWindow.get(container.html)
  if (detached === undefined || detached.size === 0) return
  const nodes = [...detached]
  detached.clear()
  for (const node of nodes) {
    const state = stateFor(node)
    if (!state.mounted || isInTree(node)) continue
    markUnmounted(node)
    state.container.renderer.destroyElement(node.nativeId)
  }
}

export function setDomTextData(text: TextInstance, data: string): void {
  if (text.text === data) return
  const previous = text.text
  text.text = data
  queueCharacterDataMutation(text, previous)
  const state = stateFor(text)
  if (state.mounted) state.container.renderer.setText(text.nativeId, data)
}
