/// Host config for React's reconciler — mutation-based protocol.
///
/// Each reconciler callback (createInstance, appendChild, commitUpdate, etc.)
/// makes a direct napi call to the Rust retained tree. No JSON serialization
/// of the full element tree. Only changed elements cross the FFI boundary.

import { createContext } from "react"
import { DefaultEventPriority } from "react-reconciler/constants.js"
import type { HostEventHandler, StyleDesc } from "@ghia/native/host"
import {
  applyStyleChange,
  assertSvgPlacement,
  createWebviewMethods,
  eventTypesWithOverrides,
  isReservedProp,
  ROOT_ELEMENT_TYPES,
  sameMutationValue,
  serializeCustomProp,
  attributesOfProps,
  forwardsCustomProp,
  hasMutationObservers,
  queueCharacterDataMutation,
  readTextControlSelection,
  recordAttributeChanges,
  requestFormSubmit,
  selectTextControl,
  setTextControlSelectionRange,
  splitMotionStyle,
  syncNativeviewListeners,
  writePopoverAttribute,
} from "@ghia/native/host"

const NoEventPriority = 0

/**
 * React DOM listens to `focusin` and `focusout` for `onFocus` and `onBlur`, so
 * they bubble. React has no `onFocusIn` or `onFocusOut`. `onInput` and `onChange`
 * depend on the element: see `fieldHandlers`.
 */
const EVENT_TYPE_BY_PROP = eventTypesWithOverrides({
  onFocus: "focusin",
  onBlur: "focusout",
  onFocusIn: null,
  onFocusOut: null,
  onInput: null,
  onChange: null,
  // A `<nativeview>`'s handlers take the pointer and nothing, not an event: see `syncNativeviewListeners`.
  onAttach: null,
  onDetach: null,
})
import { diffAttributes, diffCustomProps } from "./custom-props.js"
import { fieldHandlers } from "./field-events.js"
import { hiddenStyle } from "./native-style.js"
import type {
  Container,
  ElementType,
  FormInstance,
  HostContext,
  ImgInstance,
  Instance,
  MutationRenderer,
  Props,
  PublicInstance,
  TextControlInstance,
  TextInstance,
  WebviewInstance,
} from "../types/host.js"
import { syncMotionBindings } from "./motion-bindings.js"
import { listenersOf, unregisterEventHandlers } from "./event-registry.js"
import { insertDomNode } from "./dom-mutation.js"
import {
  containerFor,
  createHostElement,
  createHostText,
  isInTree,
  linkChild,
  livePropEntries,
  liveStyleOf,
  stateFor,
  unlinkChild,
  type HostNode,
  type HostNodeState,
} from "./host-nodes.js"

let currentUpdatePriority = NoEventPriority

/** The members every instance has sit on its prototype; the ones of its type are attached when its ref is handed out. */
function attachHostMethods(instance: Instance): PublicInstance {
  const state = stateFor(instance)
  if (!state.typeMembersAttached) {
    attachTypeMembers(instance, state.container)
    state.typeMembersAttached = true
  }
  return instance as PublicInstance
}

function attachTypeMembers(instance: Instance, container: Container): void {
  if (instance.type === "input" || instance.type === "textarea") {
    attachTextControlMethods(instance as TextControlInstance, container)
  } else if (instance.type === "form") {
    const form = instance as FormInstance
    form.requestSubmit = (submitter) =>
      requestFormSubmit(
        {
          id: form.nativeId,
          nativeRenderer: container.nativeRenderer,
          flushMutations: () => container.renderer.flushMutations(),
        },
        submitter,
      )
  } else if (instance.type === "webview") {
    Object.assign(
      instance as WebviewInstance,
      createWebviewMethods({
        id: instance.nativeId,
        nativeRenderer: container.nativeRenderer,
        flushMutations: () => container.renderer.flushMutations(),
      }),
    )
  } else if (instance.type === "img") {
    const img = instance as ImgInstance
    img.setImage = (bytes) => {
      container.nativeRenderer.setImage?.(img.nativeId, bytes as Buffer)
    }
    img.setImagePixels = (width, height, pixels, options) => {
      container.nativeRenderer.setImagePixels?.(
        img.nativeId,
        width,
        height,
        pixels as Buffer,
        options?.format,
      )
    }
  }
}

function attachTextControlMethods(control: TextControlInstance, container: Container): void {
  const host = {
    id: control.nativeId,
    nativeRenderer: container.nativeRenderer,
    flushMutations: () => container.renderer.flushMutations(),
  }
  control.select = () => selectTextControl(host)
  control.setSelectionRange = (start, end, direction) =>
    setTextControlSelectionRange(host, start, end, direction)
  Object.defineProperties(control, {
    selectionStart: { get: () => readTextControlSelection(host).start },
    selectionEnd: { get: () => readTextControlSelection(host).end },
    selectionDirection: { get: () => readTextControlSelection(host).direction },
  })
}

export function adopt(parent: Instance | undefined, child: Instance | TextInstance): void {
  if (!("type" in child)) return
  if (parent) child.parentId = parent.nativeId
  else delete child.parentId
}

/**
 * A parent code took out of the document and a flush released has no native element. What React
 * places in it is only linked, as code's own placement does, so no native orphan is made.
 */
function isReleased(parent: Instance): boolean {
  return !stateFor(parent).mounted && !isInTree(parent)
}

function rendererFor(node: HostNode): MutationRenderer {
  return containerFor(node).renderer
}

export function nextId(container: Container): number {
  return ++container.ids.nextElementId
}

/** SVG shapes, `<text>` among them, exist only inside an `<svg>`; every other element goes anywhere. */
export function assertPlacement(parent: Instance | undefined, child: Instance | TextInstance): void {
  if ("type" in child) assertSvgPlacement(parent?.type, child.type)
}

// ── Event wiring helpers ─────────────────────────────────────────────

function syncEventListeners(container: Container, instance: Instance): void {
  const listeners = listenersOf(instance)
  listeners.attach({
    eventHandlers: container.eventHandlers,
    renderer: container.renderer,
    elementId: instance.nativeId,
  })
  if (instance.type === "nativeview") syncNativeviewProps(container, instance.nativeId, instance.props as Record<string, unknown>)
  const record = instance.props as Record<string, unknown>
  for (const propName in record) {
    const eventType = EVENT_TYPE_BY_PROP.get(propName)
    const handler = record[propName]
    if (eventType && handler) listeners.setProp(eventType, handler as HostEventHandler)
  }
  const fields = fieldHandlers(instance.type, instance.props)
  if (fields.input) listeners.setProp("input", fields.input)
  if (fields.change) listeners.setProp("change", fields.change)
}

function syncNativeviewProps(
  container: Container,
  id: number,
  props: Record<string, unknown>
): void {
  syncNativeviewListeners(
    container.eventHandlers,
    container.renderer,
    id,
    props.onAttach,
    props.onDetach
  )
}

function diffNativeviewProps(
  container: Container,
  id: number,
  oldProps: Props,
  newProps: Props
): void {
  const previous = oldProps as Record<string, unknown>
  const next = newProps as Record<string, unknown>
  if (previous.onAttach === next.onAttach && previous.onDetach === next.onDetach) return
  syncNativeviewProps(container, id, next)
}

/**
 * Walks the props an element has, not every event GPUIX knows: this runs for
 * each re-rendered host element, and most have a few props and no handlers.
 */
function diffEventListeners(instance: Instance, oldProps: Props, newProps: Props): void {
  const listeners = listenersOf(instance)
  const previous = oldProps as Record<string, unknown>
  const next = newProps as Record<string, unknown>
  for (const propName in next) {
    const eventType = EVENT_TYPE_BY_PROP.get(propName)
    if (!eventType) continue
    const oldHandler = previous[propName]
    const newHandler = next[propName]
    if (oldHandler && !newHandler) {
      listeners.setProp(eventType, undefined)
    } else if (newHandler && newHandler !== oldHandler) {
      listeners.setProp(eventType, newHandler as HostEventHandler)
    }
  }
  for (const propName in previous) {
    if (propName in next) continue
    const eventType = EVENT_TYPE_BY_PROP.get(propName)
    if (eventType && previous[propName]) listeners.setProp(eventType, undefined)
  }
  if (previous.onInput === next.onInput && previous.onChange === next.onChange && previous.type === next.type) return
  const before = fieldHandlers(instance.type, oldProps)
  const after = fieldHandlers(instance.type, newProps)
  if (before.input !== after.input) listeners.setProp("input", after.input)
  if (before.change !== after.change) listeners.setProp("change", after.change)
}

// ── Style helper ─────────────────────────────────────────────────────

const NO_STYLE = {}

function sendStyle(renderer: MutationRenderer, id: number, style: StyleDesc | undefined): void {
  if (style == null || Object.keys(style).length === 0) return
  renderer.setStyle(id, style)
}

/** Sends the live style of a mounted element, as `display: none !important` while React hides it. */
export function sendLiveStyle(instance: Instance, state: HostNodeState): void {
  const style = liveStyleOf(instance)
  state.container.renderer.setStyle(instance.nativeId, state.hidden ? hiddenStyle(style) : style)
}

/**
 * Whether two `style` props reach Rust as the same payload. An absent style and
 * an empty one are the same, and so are two objects holding the same values
 * (a motion value counts as the same only when it is the same value, as it is
 * bound by identity):
 * `style={{ ... }}` is a new object on every render, so reference equality
 * alone would resend every styled element on every commit.
 *
 * Like React DOM, this does not see a style object mutated in place and passed
 * again. Pass a new object when a style changes.
 */
function sameStyle(left: Props["style"], right: Props["style"]): boolean {
  return left === right || sameMutationValue(left ?? NO_STYLE, right ?? NO_STYLE)
}

// ── Custom prop forwarding ───────────────────────────────────────────

// Props that are handled by the reconciler directly (not forwarded as custom props).
/** Send all custom props to Rust for non-built-in element types. */
function syncCustomProps(
  renderer: MutationRenderer,
  id: number,
  type: string,
  props: Iterable<readonly [string, unknown]>
): void {
  for (const [key, value] of props) {
    if (isReservedProp(key)) continue
    if (!forwardsCustomProp(type, key)) continue
    renderer.setCustomProp(id, key, serializeCustomProp(value as Parameters<typeof serializeCustomProp>[0]))
  }
}

function syncAttributes(
  renderer: MutationRenderer,
  id: number,
  type: string,
  props: Iterable<readonly [string, unknown]>
): void {
  if (!renderer.forwardsAttributes) return
  for (const [name, text] of attributesOfProps(props, type)) {
    renderer.setAttribute(id, name, text)
  }
}

/**
 * Materialize a render-phase host node only after React places its subtree in
 * the commit phase. Abandoned concurrent renders stay as collectable JS
 * objects and never enter the native mutation queue.
 */
export function materialize(node: HostNode): ReturnType<typeof stateFor> {
  const state = stateFor(node)
  if (state.mounted) return state

  const renderer = state.container.renderer
  if ("type" in node) {
    renderer.createElement(node.nativeId, node.type)
    state.container.instances.set(node.nativeId, node)
    const style = state.codeStyle ?? splitMotionStyle(node.props.style).style
    if (state.hidden) renderer.setStyle(node.nativeId, hiddenStyle(style))
    else sendStyle(renderer, node.nativeId, style)
    syncMotionBindings(state.container, node.nativeId, node.props.style, node.type)
    syncEventListeners(state.container, node)
    const liveProps = livePropEntries(node)
    syncCustomProps(renderer, node.nativeId, node.type, liveProps)
    syncAttributes(renderer, node.nativeId, node.type, liveProps)
  } else {
    renderer.createElement(node.nativeId, "#text")
    renderer.setText(node.nativeId, node.text)
  }
  state.mounted = true

  // Its children are the ones React gave it as initial children, and any that code placed in it
  // while it had no native element.
  for (const child of state.children) {
    materialize(child)
    renderer.appendChild(node.nativeId, child.nativeId)
  }
  return state
}

/**
 * Marks a node whose native element is gone, and everything inside it, as not mounted, so a
 * later placement creates it again.
 */
export function markUnmounted(node: HostNode): void {
  const state = stateFor(node)
  state.mounted = false
  for (const child of state.children) markUnmounted(child)
}

function destroyNative(container: Container, node: HostNode): void {
  markUnmounted(node)
  const destroyed = container.renderer.destroyElement(node.nativeId)
  for (const id of destroyed) {
    unregisterEventHandlers(container.eventHandlers, id)
  }
}

/** What a `ref` gives for the mounted element `id`, or `undefined` once it is gone. */
export function publicInstanceById(container: Container, id: number): PublicInstance | undefined {
  const instance = container.instances.get(id)
  return instance && attachHostMethods(instance)
}

/**
 * Makes the window's `<html>`, `<head>` and `<body>` as React makes an element and mounts them as the
 * native root, so a root's content and a portal into `document.body` go through the same
 * `body`. `base` is the container before it has them.
 */
export function installDocumentElements(base: Omit<Container, "html" | "head" | "body">): Container {
  // `html`, `head` and `body` are assigned below, before anything reads them.
  const container = base as Container
  const html = createHostElement(nextId(container), ROOT_ELEMENT_TYPES.html, {}, container)
  const head = createHostElement(nextId(container), ROOT_ELEMENT_TYPES.head, {}, container)
  const body = createHostElement(nextId(container), ROOT_ELEMENT_TYPES.body, {}, container)
  container.html = html
  container.head = head
  container.body = body
  for (const child of [head, body]) {
    adopt(html, child)
    linkChild(html, child)
  }
  materialize(html)
  materialize(head)
  materialize(body)
  container.renderer.appendChild(html.nativeId, head.nativeId)
  container.renderer.appendChild(html.nativeId, body.nativeId)
  container.renderer.setRoot(html.nativeId)
  return container
}

/** Destroys `<html>` and, with it, `<head>` and `<body>`, once the app's nodes are out of them. */
export function destroyDocumentElements(container: Container): void {
  if (container.instances.get(container.html.nativeId) !== container.html) return
  container.renderer.destroyElement(container.html.nativeId)
  container.renderer.flushMutations()
}

const portalContainers = new WeakMap<Instance, Container>()

/**
 * The container a portal into `target` mounts through.
 *
 * Cached per target because React compares a portal's `containerInfo` by
 * identity, and a new object on every render would unmount and remount the
 * portal's whole subtree.
 */
export function portalContainerFor(target: Instance): Container {
  let container = portalContainers.get(target)
  if (!container) {
    container = Object.assign(Object.create(stateFor(target).container) as Container, {
      portalTarget: target,
    })
    portalContainers.set(target, container)
  }
  return container
}

/**
 * React's new props become the element's. What code wrote stays unless React changed it: the
 * change of the `style` prop is applied onto the style code wrote, property by property, and a
 * prop React changed or removed drops code's value for it.
 */
function adoptProps(
  instance: Instance,
  state: HostNodeState,
  oldProps: Props,
  newProps: Props,
  styleChanged: boolean
): void {
  if (styleChanged && state.codeStyle !== undefined) {
    state.codeStyle = applyStyleChange(
      state.codeStyle,
      splitMotionStyle(oldProps.style).style ?? {},
      splitMotionStyle(newProps.style).style ?? {}
    )
  }
  const overrides = state.propOverrides
  if (overrides !== undefined) {
    const previous = oldProps as Record<string, unknown>
    const next = newProps as Record<string, unknown>
    for (const name of [...overrides.keys()]) if (previous[name] !== next[name]) overrides.delete(name)
  }
  instance.props = newProps
}

  const overridesBefore = state.propOverrides === undefined ? undefined : new Map(state.propOverrides)
function applyUpdate(instance: Instance, oldProps: Props, newProps: Props): void {
  const state = stateFor(instance)
  const container = state.container
  // `commitUpdate` runs for every host element whose props object is new,
  // which is every element a parent re-rendered. Most of those did not change
  // their style, so send it only when it did.
  const styleChanged = !sameStyle(oldProps.style, newProps.style)
  if (hasMutationObservers()) {
    recordAttributeChanges(instance, new Set([...Object.keys(oldProps), ...Object.keys(newProps)]), () => {
      adoptProps(instance, state, oldProps, newProps, styleChanged)
    })
  } else {
    adoptProps(instance, state, oldProps, newProps, styleChanged)
  }
  // Code took it out of the document and native let it go: it is made again, from these
  // props, when it is inserted. Its handler slots are kept up to date meanwhile, because that
  // re-registers them; they do not reach native, which has no element for them.
  if (!state.mounted) {
    diffEventListeners(instance, oldProps, newProps)
    return
  }
  if (styleChanged) {
    sendLiveStyle(instance, state)
    syncMotionBindings(container, instance.nativeId, newProps.style, instance.type)
  }
  diffEventListeners(instance, oldProps, newProps)
  if (instance.type === "nativeview") {
    diffNativeviewProps(container, instance.nativeId, oldProps, newProps)
  }
  // Custom prop diff (for non-div/text elements)
  diffCustomProps(container.renderer, instance.nativeId, instance.type, oldProps, newProps)
  // What code wrote is an attribute too (a script's `defaultValue` answers the `value` attribute over a controlled `value`).
  diffAttributes(
    container.renderer,
    instance.nativeId,
    instance.type,
    withOverrides(oldProps, overridesBefore),
    withOverrides(newProps, state.propOverrides)
  )
}

function withOverrides(props: Props, overrides: ReadonlyMap<string, unknown> | undefined): Props {
  return overrides === undefined ? props : ({ ...props, ...Object.fromEntries(overrides) } as Props)
}

// ── Host config ──────────────────────────────────────────────────────

export const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  // React creates host nodes while rendering and may abandon that work in
  // concurrent mode. Keep the description in JS; materialize it only from a
  // commit-phase placement callback.
  createInstance(
    type: ElementType,
    props: Props,
    rootContainerInstance: Container,
    _hostContext: HostContext
  ): Instance {
    return createHostElement(nextId(rootContainerInstance), type, props, rootContainerInstance)
  },

  appendChild(parent: Instance, child: Instance | TextInstance): void {
    if (isReleased(parent)) return insertDomNode(parent, child, null)
    assertPlacement(parent, child)
    const parentState = materialize(parent)
    materialize(child)
    adopt(parent, child)
    linkChild(parent, child)
    parentState.container.renderer.appendChild(parent.nativeId, child.nativeId)
  },

  // React only calls this from the deletion path, never to move a node, so the
  // child is gone for good and has to be freed here. Detaching alone leaked
  // every removed text node: `detachDeletedInstance` runs for host components
  // only, so nothing else would ever destroy a `HostText`.
  removeChild(parent: Instance, child: Instance | TextInstance): void {
    unlinkChild(child)
    destroyNative(containerFor(parent), child)
  },

  insertBefore(
    parent: Instance,
    child: Instance | TextInstance,
    beforeChild: Instance | TextInstance
  ): void {
    if (isReleased(parent)) return insertDomNode(parent, child, beforeChild)
    assertPlacement(parent, child)
    const parentState = materialize(parent)
    materialize(child)
    adopt(parent, child)
    linkChild(parent, child, beforeChild)
    parentState.container.renderer.insertBefore(parent.nativeId, child.nativeId, beforeChild.nativeId)
  },

  // The children of a window's root and of a portal share their target, `body` or the
  // portal's, with whatever else it holds, and React places one before another whenever
  // their keys reorder.
  insertInContainerBefore(
    container: Container,
    child: Instance,
    beforeChild: Instance
  ): void {
    const target = container.portalTarget ?? container.body
    if (isReleased(target)) return insertDomNode(target, child, beforeChild)
    assertPlacement(target, child)
    materialize(child)
    adopt(target, child)
    linkChild(target, child, beforeChild)
    container.renderer.insertBefore(target.nativeId, child.nativeId, beforeChild.nativeId)
  },

  removeChildFromContainer(parent: Container, child: Instance): void {
    unlinkChild(child)
    destroyNative(parent, child)
  },

  prepareForCommit(_containerInfo: Container): Record<string, unknown> | null {
    return null
  },

  // Batch flush point: flushMutations() sends all queued mutations to Rust
  // in a single applyBatch() FFI call. This is the end of React's synchronous
  // commit phase — all mutations from this render are flushed together.
  // An error thrown here is not caught per fiber like the rest of the commit:
  // React leaves its `isFlushingWork` flag set, and from then on no root in the
  // process commits a synchronous update. Report it as the root's uncaught
  // error instead, like a component's.
  resetAfterCommit(containerInfo: Container): void {
    try {
      containerInfo.renderer.flushMutations()
    } catch (error) {
      containerInfo.onUncaughtError(error instanceof Error ? error : new Error(String(error)), {})
    }
  },

  getRootHostContext(_rootContainerInstance: Container): HostContext {
    return {}
  },

  getChildHostContext(
    parentHostContext: HostContext,
    _type: ElementType,
    _rootContainerInstance: Container
  ): HostContext {
    return parentHostContext
  },

  shouldSetTextContent(_type: ElementType, _props: Props): boolean {
    return false
  },

  createTextInstance(
    text: string,
    rootContainerInstance: Container,
    _hostContext: HostContext
  ): TextInstance {
    return createHostText(nextId(rootContainerInstance), text, rootContainerInstance)
  },

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,

  shouldAttemptEagerTransition(): boolean {
    return false
  },

  finalizeInitialChildren(
    _instance: Instance,
    _type: ElementType,
    _props: Props,
    _rootContainerInstance: Container,
    _hostContext: HostContext
  ): boolean {
    return false
  },

  commitMount(
    _instance: Instance,
    _type: ElementType,
    _props: Props,
    _internalInstanceHandle: unknown
  ): void {},

  commitUpdate(
    instance: Instance,
    _type: ElementType,
    oldProps: Props,
    newProps: Props,
    _internalInstanceHandle: unknown
  ): void {
    // A showing popover whose `popover` prop changed closes, with its events, once the whole update is queued.
    if (oldProps.popover !== newProps.popover) {
      writePopoverAttribute(instance, () => applyUpdate(instance, oldProps, newProps))
    } else {
      applyUpdate(instance, oldProps, newProps)
    }
  },

  commitTextUpdate(
    textInstance: TextInstance,
    _oldText: string,
    newText: string
  ): void {
    if (stateFor(textInstance).mounted) rendererFor(textInstance).setText(textInstance.nativeId, newText)
    const oldValue = textInstance.text
    textInstance.text = newText
    queueCharacterDataMutation(textInstance, oldValue)
  },

  appendChildToContainer(container: Container, child: Instance): void {
    const target = container.portalTarget ?? container.body
    if (isReleased(target)) return insertDomNode(target, child, null)
    assertPlacement(target, child)
    materialize(child)
    adopt(target, child)
    materialize(target)
    linkChild(target, child)
    container.renderer.appendChild(target.nativeId, child.nativeId)
  },

  appendInitialChild(parent: Instance, child: Instance | TextInstance): void {
    assertPlacement(parent, child)
    adopt(parent, child)
    linkChild(parent, child)
  },

  hideInstance(instance: Instance): void {
    // Keep the element's own style under `display: none !important`, so a sheet
    // rule cannot show what Suspense hides and unhiding restores it as it was.
    const state = stateFor(instance)
    state.hidden = true
    if (state.mounted) rendererFor(instance).setStyle(instance.nativeId, hiddenStyle(liveStyleOf(instance)))
  },

  unhideInstance(instance: Instance, _props: Props): void {
    const state = stateFor(instance)
    state.hidden = false
    if (state.mounted) sendLiveStyle(instance, state)
  },

  hideTextInstance(_textInstance: TextInstance): void {},
  unhideTextInstance(_textInstance: TextInstance, _text: string): void {},

  clearContainer(_container: Container): void {},

  setCurrentUpdatePriority(newPriority: number): void {
    currentUpdatePriority = newPriority
  },

  getCurrentUpdatePriority: (): number => currentUpdatePriority,

  resolveUpdatePriority(): number {
    if (currentUpdatePriority !== NoEventPriority) {
      return currentUpdatePriority
    }
    return DefaultEventPriority
  },

  maySuspendCommit(): boolean {
    return false
  },

  NotPendingTransition: null,
  HostTransitionContext: createContext(null),
  resetFormInstance(): void {},
  requestPostPaintCallback(): void {},
  trackSchedulerEvent(): void {},

  resolveEventType(): null {
    return null
  },

  resolveEventTimeStamp(): number {
    return -1.1
  },

  preloadInstance(): boolean {
    return true
  },

  startSuspendingCommit(): void {},
  suspendInstance(): void {},

  waitForCommitToBeReady(): null {
    return null
  },

  detachDeletedInstance(instance: Instance): void {
    destroyNative(containerFor(instance), instance)
  },

  getPublicInstance(instance: Instance): PublicInstance {
    return attachHostMethods(instance)
  },

  preparePortalMount(_containerInfo: Container): void {},
  isPrimaryRenderer: true,

  getInstanceFromNode(): null {
    return null
  },

  beforeActiveInstanceBlur(): void {},
  afterActiveInstanceBlur(): void {},
  prepareScopeUpdate(): void {},

  getInstanceFromScope(): null {
    return null
  },
}
