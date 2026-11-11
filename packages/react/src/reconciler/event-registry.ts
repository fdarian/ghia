import type { EventPayload } from "@ghia/native"
import {
  createRendererState,
  ElementListeners,
  registerEventHandler,
  registerEventListener,
  unregisterEventHandler,
  unregisterEventListener,
  unregisterEventHandlers,
} from "@ghia/native/host"
import type {
  Container,
  ElementIdAllocator,
  EventHandlerMap,
  Instance,
  NativeRenderer,
} from "../types/host.js"

const listenersByInstance = new WeakMap<Instance, ElementListeners>()

/** The event listeners of a host instance, and its `on*` props among them. */
export function listenersOf(instance: Instance): ElementListeners {
  const existing = listenersByInstance.get(instance)
  if (existing) return existing
  const created = new ElementListeners()
  listenersByInstance.set(instance, created)
  return created
}

/** The element is gone natively: its listeners stay on the instance but register nowhere. */
export function detachListeners(instance: Instance): void {
  listenersByInstance.get(instance)?.detach()
}

const bindings = new WeakMap<Container, { detach(): boolean }>()

export function idAllocatorFor(renderer: NativeRenderer): ElementIdAllocator {
  return createRendererState(renderer).ids
}

export function attachRoot(
  renderer: NativeRenderer,
  container: Container,
  schedule: (dispatch: () => void) => void,
  afterEvent: (event: EventPayload) => void
): void {
  const binding = createRendererState(renderer).attach({
    eventHandlers: container.eventHandlers,
    onWindowKeyDown: container.windowKeyEventHandlers.onKeyDown,
    onWindowKeyUp: container.windowKeyEventHandlers.onKeyUp,
    onSelectionChange: container.windowKeyEventHandlers.onSelectionChange,
    onAppearanceChange: container.windowKeyEventHandlers.onAppearanceChange,
    tabNavigation: container.windowKeyEventHandlers.tabNavigation,
    onEvent: container.onEvent,
    schedule,
    afterEvent,
  })
  container.windowKeyEventId = binding.windowKeyEventId
  container.windowSelectionEventId = binding.windowSelectionEventId
  container.windowAppearanceEventId = binding.windowAppearanceEventId
  bindings.set(container, binding)
}

export function detachRoot(_renderer: NativeRenderer, container: Container): boolean {
  const binding = bindings.get(container)
  if (!binding) return false
  bindings.delete(container)
  return binding.detach()
}

export function handleGpuixEvent(
  payload: EventPayload,
  renderer: NativeRenderer
): boolean {
  return createRendererState(renderer).dispatch(payload)
}

export {
  registerEventHandler,
  registerEventListener,
  unregisterEventHandler,
  unregisterEventListener,
  unregisterEventHandlers,
}

export type { EventHandlerMap }
