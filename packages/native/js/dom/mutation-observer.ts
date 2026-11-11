/**
 * `MutationObserver` and `MutationRecord`, with the queue the adapters feed from their own
 * tree changes. A node's tree is the adapter's, so nothing here watches it: an adapter calls
 * `queueChildListMutation`, `queueAttributeMutation` or `queueCharacterDataMutation` after it
 * changes a node, and those find the observers by walking `parentNode` from the target, as
 * the DOM standard's "queue a mutation record" does.
 *
 * With no observer alive every hook is one integer check, and no node gets a field: the
 * registrations live in a `WeakMap` that is only written by `observe()`.
 *
 * An observer does not keep what it observes alive, as in the DOM standard (its node list is
 * weak). The only strong edge is node to registration, in that `WeakMap`; the observer holds
 * `WeakRef`s of its registrations, and a `FinalizationRegistry` takes a collected registration
 * out of the observer and out of the live count.
 */

import { reportUncaught } from "../events/dispatch.js"
import { attributeNameOf } from "./attribute-names.js"
import { NOT_ATTRIBUTES, Node, SVGElement, type Element } from "./nodes.js"

export type MutationObserverInit = {
  childList?: boolean
  attributes?: boolean
  characterData?: boolean
  subtree?: boolean
  attributeOldValue?: boolean
  characterDataOldValue?: boolean
  attributeFilter?: readonly string[]
}

type MutationType = "attributes" | "characterData" | "childList"

type NormalizedOptions = {
  childList: boolean
  attributes: boolean
  characterData: boolean
  subtree: boolean
  attributeOldValue: boolean
  characterDataOldValue: boolean
  attributeFilter: readonly string[] | null
}

type RecordInit = {
  type: MutationType
  target: Node
  addedNodes: readonly Node[]
  removedNodes: readonly Node[]
  previousSibling: Node | null
  nextSibling: Node | null
  attributeName: string | null
  oldValue: string | null
}

type Registration = {
  node: Node
  options: NormalizedOptions
  /** Set on a transient registration: the one on an ancestor that it stands in for until the next delivery. */
  source: Registration | null
  observer: ObserverState
}

type ObserverState = {
  readonly observer: MutationObserverClass
  readonly callback: MutationCallback
  /** Observers are notified in the order they were made. */
  readonly order: number
  records: MutationRecordClass[]
  readonly registrations: Set<WeakRef<Registration>>
  readonly transients: Set<Registration>
}

export type MutationCallback = (records: MutationRecord[], observer: MutationObserver) => void

/**
 * What the finalization registry holds, strongly and from a global root: only the observer's set of
 * refs, never the observer, whose callback usually captures the observed node.
 */
type CollectedRegistration = {
  readonly set: Set<WeakRef<Registration>>
  readonly ref: WeakRef<Registration>
}

const CREATE = Symbol("create mutation record")

/** What happened to a node, as `MutationObserver` delivers it. It is only made by the queue. */
class MutationRecordClass {
  readonly type: MutationType
  readonly target: Node
  readonly addedNodes: readonly Node[]
  readonly removedNodes: readonly Node[]
  readonly previousSibling: Node | null
  readonly nextSibling: Node | null
  readonly attributeName: string | null
  /** Ghia has no namespaced attributes. */
  readonly attributeNamespace: null = null
  readonly oldValue: string | null

  constructor(token: symbol, init: RecordInit) {
    if (token !== CREATE) throw new TypeError("Illegal constructor")
    this.type = init.type
    this.target = init.target
    this.addedNodes = init.addedNodes
    this.removedNodes = init.removedNodes
    this.previousSibling = init.previousSibling
    this.nextSibling = init.nextSibling
    this.attributeName = init.attributeName
    this.oldValue = init.oldValue
  }
}

type Runtime = {
  MutationObserver: typeof MutationObserverClass
  MutationRecord: typeof MutationRecordClass
  /** The records made by the copy that owns the classes: its `CREATE` is the only token they accept. */
  createRecord(init: RecordInit): MutationRecordClass
  registrations: WeakMap<Node, Registration[]>
  /**
   * Registrations in `registrations`, transient ones too: 0 means every hook has nothing to do.
   * It drops when `observe()`d nodes are collected, through `collected`.
   */
  count: number
  /** Notices a registration made by `observe()` being collected: it was not disconnected. */
  collected: FinalizationRegistry<CollectedRegistration>
  nextOrder: number
  /** Observers with records waiting for the next delivery. */
  pending: Set<ObserverState>
  /** Observers that have transient registrations, which the next delivery drops. */
  transientHolders: Set<ObserverState>
  deliveryQueued: boolean
}

const states = new WeakMap<MutationObserverClass, ObserverState>()

function stateOf(observer: MutationObserverClass): ObserverState {
  const state = states.get(observer)
  if (state === undefined) throw new TypeError("Illegal invocation")
  return state
}

function normalize(init: MutationObserverInit | undefined): NormalizedOptions {
  if (init === undefined || init === null || typeof init !== "object") {
    throw new TypeError("Failed to execute 'observe' on 'MutationObserver': The options object must be an object.")
  }
  const attributeFilter = init.attributeFilter === undefined ? null : Array.from(init.attributeFilter, String)
  const attributes = init.attributes ?? (init.attributeOldValue !== undefined || attributeFilter !== null)
  const characterData = init.characterData ?? init.characterDataOldValue !== undefined
  const childList = Boolean(init.childList)
  const fail = (message: string): never => {
    throw new TypeError(`Failed to execute 'observe' on 'MutationObserver': ${message}`)
  }
  if (!childList && !attributes && !characterData) {
    fail("The options object must set at least one of 'attributes', 'characterData', or 'childList' to true.")
  }
  if (!attributes && init.attributeOldValue) {
    fail("The options object may only set 'attributeOldValue' to true when 'attributes' is true or not present.")
  }
  if (!attributes && attributeFilter !== null) {
    fail("The options object may only set 'attributeFilter' when 'attributes' is true or not present.")
  }
  if (!characterData && init.characterDataOldValue) {
    fail("The options object may only set 'characterDataOldValue' to true when 'characterData' is true or not present.")
  }
  return {
    childList,
    attributes: Boolean(attributes),
    characterData: Boolean(characterData),
    subtree: Boolean(init.subtree),
    attributeOldValue: Boolean(init.attributeOldValue),
    characterDataOldValue: Boolean(init.characterDataOldValue),
    attributeFilter,
  }
}

function addRegistration(runtime: Runtime, registration: Registration): void {
  const list = runtime.registrations.get(registration.node)
  if (list === undefined) runtime.registrations.set(registration.node, [registration])
  else list.push(registration)
  runtime.count += 1
}

function removeRegistration(runtime: Runtime, registration: Registration): void {
  const list = runtime.registrations.get(registration.node)
  if (list === undefined) return
  const index = list.indexOf(registration)
  if (index < 0) return
  runtime.collected.unregister(registration)
  list.splice(index, 1)
  if (list.length === 0) runtime.registrations.delete(registration.node)
  runtime.count -= 1
}

function dropTransients(runtime: Runtime, state: ObserverState, source?: Registration): void {
  for (const transient of [...state.transients]) {
    if (source !== undefined && transient.source !== source) continue
    state.transients.delete(transient)
    removeRegistration(runtime, transient)
  }
  if (state.transients.size === 0) runtime.transientHolders.delete(state)
}

/** The registration this observer made on `node` itself with `observe`, not a transient one. */
function registrationFor(runtime: Runtime, node: Node, state: ObserverState): Registration | undefined {
  return runtime.registrations.get(node)?.find((entry) => entry.observer === state && entry.source === null)
}

class MutationObserverClass {
  constructor(callback: MutationCallback) {
    if (typeof callback !== "function") {
      throw new TypeError("Failed to construct 'MutationObserver': The callback provided as parameter 1 is not a function.")
    }
    const runtime = shared
    states.set(this, {
      observer: this,
      callback,
      order: runtime.nextOrder++,
      records: [],
      registrations: new Set(),
      transients: new Set(),
    })
  }

  observe(target: Node, options?: MutationObserverInit): void {
    if (!(target instanceof Node)) {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.")
    }
    const runtime = shared
    const state = stateOf(this)
    const normalized = normalize(options)
    const existing = registrationFor(runtime, target, state)
    if (existing !== undefined) {
      dropTransients(runtime, state, existing)
      existing.options = normalized
      return
    }
    const registration: Registration = { node: target, options: normalized, source: null, observer: state }
    const ref = new WeakRef(registration)
    state.registrations.add(ref)
    runtime.collected.register(registration, { set: state.registrations, ref }, registration)
    addRegistration(runtime, registration)
  }

  disconnect(): void {
    const runtime = shared
    const state = stateOf(this)
    for (const ref of state.registrations) {
      const registration = ref.deref()
      if (registration !== undefined) removeRegistration(runtime, registration)
    }
    state.registrations.clear()
    dropTransients(runtime, state)
    state.records = []
    runtime.pending.delete(state)
  }

  takeRecords(): MutationRecord[] {
    const state = stateOf(this)
    const records = state.records
    state.records = []
    shared.pending.delete(state)
    return records
  }
}

export type MutationRecord = MutationRecordClass
export type MutationObserver = MutationObserverClass

const RUNTIME_KEY = Symbol.for("@ghia/native/mutation-observer")

/**
 * Kept on `globalThis`, like the DOM classes: a second copy of this package must share the
 * registrations, or an adapter from one copy would queue into an observer of the other.
 */
const shared: Runtime = (() => {
  const existing = Reflect.get(globalThis, RUNTIME_KEY) as Runtime | undefined
  if (existing) return existing
  Object.defineProperty(MutationObserverClass, "name", { value: "MutationObserver" })
  Object.defineProperty(MutationRecordClass, "name", { value: "MutationRecord" })
  const created: Runtime = {
    MutationObserver: MutationObserverClass,
    MutationRecord: MutationRecordClass,
    createRecord: (init) => new MutationRecordClass(CREATE, init),
    registrations: new WeakMap(),
    count: 0,
    collected: new FinalizationRegistry((held) => {
      held.set.delete(held.ref)
      created.count -= 1
    }),
    nextOrder: 0,
    pending: new Set(),
    transientHolders: new Set(),
    deliveryQueued: false,
  }
  Reflect.set(globalThis, RUNTIME_KEY, created)
  return created
})()

export const MutationObserver = shared.MutationObserver
export const MutationRecord = shared.MutationRecord

/** Whether any observer is watching a node. Every hook returns early while this is false. */
export function hasMutationObservers(): boolean {
  return shared.count > 0
}

function scheduleDelivery(): void {
  if (shared.deliveryQueued) return
  shared.deliveryQueued = true
  queueMicrotask(deliver)
}

function deliver(): void {
  const runtime = shared
  runtime.deliveryQueued = false
  const notify = [...new Set([...runtime.pending, ...runtime.transientHolders])].sort(
    (left, right) => left.order - right.order
  )
  runtime.pending.clear()
  for (const state of notify) {
    dropTransients(runtime, state)
    const records = state.records
    if (records.length === 0) continue
    state.records = []
    try {
      state.callback.call(state.observer, records, state.observer)
    } catch (error) {
      reportUncaught(error)
    }
  }
}

function queueRecord(init: RecordInit, oldValue: string | null): void {
  const runtime = shared
  const interested = new Map<ObserverState, string | null>()
  for (let node: Node | null = init.target; node !== null; node = node.parentNode) {
    const registrations = runtime.registrations.get(node)
    if (registrations === undefined) continue
    for (const registration of registrations) {
      const options = registration.options
      if (node !== init.target && !options.subtree) continue
      if (init.type === "attributes") {
        if (!options.attributes) continue
        if (options.attributeFilter !== null && !options.attributeFilter.includes(init.attributeName as string)) continue
      } else if (init.type === "characterData") {
        if (!options.characterData) continue
      } else if (!options.childList) {
        continue
      }
      if (!interested.has(registration.observer)) interested.set(registration.observer, null)
      const wantsOldValue =
        (init.type === "attributes" && options.attributeOldValue) ||
        (init.type === "characterData" && options.characterDataOldValue)
      if (wantsOldValue) interested.set(registration.observer, oldValue)
    }
  }
  if (interested.size === 0) return
  for (const [state, mappedOldValue] of interested) {
    state.records.push(runtime.createRecord({ ...init, oldValue: mappedOldValue }))
    runtime.pending.add(state)
  }
  scheduleDelivery()
}

/**
 * Call after `added` were placed in `target` and `removed` taken out, with the siblings the
 * change happened between. For one node leaving, pass its siblings from before it left.
 */
export function queueChildListMutation(
  target: Node,
  added: readonly Node[],
  removed: readonly Node[],
  previousSibling: Node | null,
  nextSibling: Node | null
): void {
  if (shared.count === 0) return
  if (removed.length > 0) addTransientRegistrations(target, removed)
  queueRecord(
    {
      type: "childList",
      target,
      addedNodes: added,
      removedNodes: removed,
      previousSibling,
      nextSibling,
      attributeName: null,
      oldValue: null,
    },
    null
  )
}

/**
 * A subtree observer keeps hearing of what happens inside a node that was removed from the
 * subtree, until it has been delivered its records once more.
 */
function addTransientRegistrations(parent: Node, removed: readonly Node[]): void {
  const runtime = shared
  for (let node: Node | null = parent; node !== null; node = node.parentNode) {
    const registrations = runtime.registrations.get(node)
    if (registrations === undefined) continue
    for (const registration of [...registrations]) {
      if (!registration.options.subtree) continue
      for (const child of removed) {
        const known = runtime.registrations.get(child)
        if (known?.some((entry) => entry.source === registration)) continue
        const transient: Registration = {
          node: child,
          options: registration.options,
          source: registration,
          observer: registration.observer,
        }
        registration.observer.transients.add(transient)
        runtime.transientHolders.add(registration.observer)
        addRegistration(runtime, transient)
      }
    }
  }
  scheduleDelivery()
}

/** Call after the attribute `name` of `target` changed, with what `getAttribute(name)` read before. */
export function queueAttributeMutation(target: Element, name: string, oldValue: string | null): void {
  if (shared.count === 0) return
  queueRecord(
    {
      type: "attributes",
      target,
      addedNodes: [],
      removedNodes: [],
      previousSibling: null,
      nextSibling: null,
      attributeName: name,
      oldValue: null,
    },
    oldValue
  )
}

/** Call after the text of `target` changed, with the text it had before. */
export function queueCharacterDataMutation(target: Node, oldValue: string): void {
  if (shared.count === 0) return
  queueRecord(
    {
      type: "characterData",
      target,
      addedNodes: [],
      removedNodes: [],
      previousSibling: null,
      nextSibling: null,
      attributeName: null,
      oldValue: null,
    },
    oldValue
  )
}

/**
 * Runs `apply`, which changes the props `propNames` of `element`, and queues a record for each
 * attribute `getAttribute` reads differently afterwards, with the value it read before. A
 * prop that is no attribute (a handler, an object, `style`, `children`) reads `null` on both
 * sides and produces nothing. Only call it while `hasMutationObservers()`.
 */
export function recordAttributeChanges(element: Element, propNames: Iterable<string>, apply: () => void): void {
  const names: string[] = []
  const svg = element instanceof SVGElement
  for (const prop of propNames) {
    if (NOT_ATTRIBUTES.has(prop)) continue
    const name = attributeNameOf(prop, svg)
    if (!names.includes(name)) names.push(name)
  }
  const before = names.map((name) => element.getAttribute(name))
  apply()
  names.forEach((name, index) => {
    if (element.getAttribute(name) !== before[index]) queueAttributeMutation(element, name, before[index])
  })
}
