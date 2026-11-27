import type { NativeRenderer } from "./host.js"
import { runAll } from "./run-all.js"
import { registerWindowDisposer } from "./window-lifecycle.js"

/**
 * What an adapter's `render()` keeps for each renderer it mounts on: the window it opens itself, and each renderer it is
 * given. An adapter extends it with the state of its own mount.
 */
export interface RenderSlot {
  renderer?: NativeRenderer
  root?: { unmount(): void }
  loop?: { stop(): void }
}

interface RenderHosts {
  /** The slot of `render` calls that name no renderer, which own the window and its frame loop. */
  own?: RenderSlot
  readonly slots: Set<RenderSlot>
}

/**
 * Kept on `globalThis`: under `bun --hot` and `ghia dev` the adapter is evaluated again while the window, its renderer and
 * its frame loop stay, and the new evaluation must find the slot to mount on again.
 */
const RENDER_HOSTS_KEY = Symbol.for("@ghia/native/render-hosts")

function hostsOrUndefined(): RenderHosts | undefined {
  return Reflect.get(globalThis, RENDER_HOSTS_KEY) as RenderHosts | undefined
}

function hosts(): RenderHosts {
  const existing = hostsOrUndefined()
  if (existing !== undefined) return existing
  const created: RenderHosts = { slots: new Set() }
  Reflect.set(globalThis, RENDER_HOSTS_KEY, created)
  return created
}

/**
 * The slot `render` mounts on: the one of `injected`, or the app's own for a call that names no renderer. It is made on the
 * first call, and an adapter that makes the renderer afterwards gives it to the slot with `bindRenderSlot`.
 */
export function renderSlotFor<Slot extends RenderSlot>(injected: NativeRenderer | undefined): Slot {
  const all = hosts()
  if (injected === undefined) {
    all.own ??= {}
    all.slots.add(all.own)
    return all.own as Slot
  }
  for (const known of all.slots) if (known.renderer === injected) return known as Slot
  const created: Slot = { renderer: injected } as Slot
  all.slots.add(created)
  bindRenderSlot(created, injected)
  return created
}

/**
 * Sets the renderer of `slot`, and drops the slot when that renderer's window is gone (the user closed it, a script did, the
 * app ended, or a test renderer was disposed), so that a later `render()` makes a new window instead of mounting on a dead
 * one, and the slots of disposed renderers do not pile up.
 */
export function bindRenderSlot(slot: RenderSlot, renderer: NativeRenderer): void {
  slot.renderer = renderer
  const all = hosts()
  registerWindowDisposer(renderer, () => {
    all.slots.delete(slot)
    if (all.own === slot) all.own = undefined
  })
}

/** The live slots, in the order they were made. */
export function renderSlots<Slot extends RenderSlot>(): Slot[] {
  return [...(hostsOrUndefined()?.slots ?? [])] as Slot[]
}

/** The slot of the window `render()` opened itself, or `undefined` before that and after that window is gone. */
export function ownRenderSlot<Slot extends RenderSlot>(): Slot | undefined {
  return hostsOrUndefined()?.own as Slot | undefined
}

/**
 * The renderer of the window `render()` opened itself (not one it was given), for a test or a script that drives the app's
 * own window. `undefined` before that window opens and after it closes.
 */
export function ownRenderer(): NativeRenderer | undefined {
  return ownRenderSlot()?.renderer
}

/** Stops every frame loop and unmounts every root `render()` mounted, and forgets the slots: `resetRender()` of the adapters. */
export function resetRenderSlots(): void {
  const all = hostsOrUndefined()
  if (all === undefined) return
  Reflect.deleteProperty(globalThis, RENDER_HOSTS_KEY)
  runAll(
    all.slots,
    (slot) => {
      try {
        slot.loop?.stop()
      } finally {
        slot.root?.unmount()
      }
    },
    "Resetting the render slots failed"
  )
}
