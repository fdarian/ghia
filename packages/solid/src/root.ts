import { createComponent, createContext, useContext, type JSX } from "solid-js"
import type { EventPayload } from "@ghia/native"
import {
  createMutationQueue,
  createRendererState,
  installElementSource,
  runMotionReleases,
  syncWindowEventListeners,
  syncWindowSelectionChange,
  unregisterEventHandlers,
} from "@ghia/native/host"
import { toAppearance } from "@ghia/native/host"
import type {
  Appearance,
  MutationRenderer,
  NativeRenderer,
  RendererRootBinding,
  RootEvent,
  RootEventHandlers,
} from "@ghia/native/host"
import { HostRoot, removeHostNode } from "./host.js"
import { universalRender } from "./universal.js"

export interface GpuixContextValue {
  renderer: NativeRenderer
  /** The root's mutation queue, for what must be ordered with its element mutations. */
  mutations: MutationRenderer
  subscribeSelection(callback: (text: string | null) => void): () => void
  subscribeAppearance(callback: (appearance: Appearance) => void): () => void
}

export const GpuixContext = createContext<GpuixContextValue>()

export function useGpuix(): GpuixContextValue | undefined {
  return useContext(GpuixContext)
}

export function useGpuixRequired(): NativeRenderer {
  const value = useGpuix()
  if (!value) throw new Error("useGpuixRequired must be used inside a GPUIX root")
  return value.renderer
}

export interface Root {
  render(code: () => JSX.Element): void
  flush(): void
  flushSync<Value>(fn: () => Value): Value
  dispatch(event: EventPayload): boolean
  unmount(): void
}

export function createRoot(
  renderer: NativeRenderer,
  rootHandlers: RootEventHandlers = {}
): Root {
  const state = createRendererState(renderer)
  const eventHandlers = new Map()
  const mutations = createMutationQueue(renderer, (ids) => {
    for (const id of ids) {
      unregisterEventHandlers(eventHandlers, id)
      // `markUnmounted` leaves a `<nativeview>`'s listeners attached so it hears `detach` while this batch is applied; now they go.
      container.elements.get(id)?.listeners.detach()
      container.elements.delete(id)
    }
    runMotionReleases(container)
  }, (flush) => {
    queueMicrotask(() => {
      try {
        container.finishRemovals()
        flush()
      } catch (error) {
        rootHandlers.onUncaughtError?.(
          error instanceof Error ? error : new Error(String(error)),
          {}
        )
      }
    })
  })
  const container = new HostRoot({
    mutations,
    nativeRenderer: renderer,
    eventHandlers,
    allocateId: () => ++state.ids.nextElementId,
  })
  mutations.setElementSource({
    forEachElement(visit) {
      for (const node of container.elements.values()) visit(node.nativeId, node.type, node.props)
    },
    rememberAttributes(id, attributes) {
      container.elements.get(id)?.sent.rememberAttributes(attributes)
    },
  })
  let binding: RendererRootBinding | undefined
  let stopWindowEventListeners: (() => void) | undefined
  let selectionChange: ReturnType<typeof syncWindowSelectionChange> | undefined
  let stopElementSource: (() => void) | undefined
  let dispose: (() => void) | undefined
  const selectionListeners = new Set<(text: string | null) => void>()
  const onSelectionChange = (event: RootEvent, currentRenderer: NativeRenderer) => {
    rootHandlers.onSelectionChange?.(event, currentRenderer)
    for (const listener of selectionListeners) listener(event.value ?? null)
  }
  const syncSelection = () => selectionChange?.resync()

  const appearanceListeners = new Set<(appearance: Appearance) => void>()
  const onAppearanceChange = (event: RootEvent, currentRenderer: NativeRenderer) => {
    rootHandlers.onAppearanceChange?.(event, currentRenderer)
    const appearance = toAppearance(event.value)
    for (const listener of appearanceListeners) listener(appearance)
  }
  const syncAppearance = () => {
    if (!binding) return
    renderer.setWindowAppearanceChange?.(
      Boolean(rootHandlers.onAppearanceChange) || appearanceListeners.size > 0,
      binding.windowAppearanceEventId
    )
  }

  const attach = () => {
    binding = state.attach({
      eventHandlers,
      onWindowKeyDown: rootHandlers.onKeyDown,
      onWindowKeyUp: rootHandlers.onKeyUp,
      onSelectionChange,
      onAppearanceChange,
      tabNavigation: rootHandlers.tabNavigation,
      onEvent: rootHandlers.onEvent,
      // The flush stands in for the microtask checkpoint a browser runs before it renders.
      schedule: (run) => {
        try {
          run()
        } finally {
          flush()
        }
      },
    })
    renderer.setWindowKeyEvents?.(
      // Always on: the Tab and Escape defaults run on the key event, and
      // `window` listeners can be added at any time.
      true,
      true,
      binding.windowKeyEventId
    )
    stopWindowEventListeners = syncWindowEventListeners(renderer)
    stopElementSource = installElementSource(
      renderer,
      (id) => container.elements.get(id),
      () => ({ html: container.html, head: container.head, body: container.body })
    )
    // Sent on every attach, so a remount without the option restores the default.
    mutations.setKeyboardFocusDim(rootHandlers.keyboardFocusDim !== false)
    selectionChange = syncWindowSelectionChange(
      renderer,
      binding.windowSelectionEventId,
      () => Boolean(rootHandlers.onSelectionChange) || selectionListeners.size > 0
    )
    syncAppearance()
  }

  const detach = () => {
    if (!binding?.detach()) return
    renderer.setWindowKeyEvents?.(false, false, binding.windowKeyEventId)
    stopWindowEventListeners?.()
    stopWindowEventListeners = undefined
    stopElementSource?.()
    stopElementSource = undefined
    selectionChange?.stop()
    selectionChange = undefined
    renderer.setWindowAppearanceChange?.(false, binding.windowAppearanceEventId)
    binding = undefined
  }

  attach()
  const flush = () => {
    container.finishRemovals()
    mutations.flushMutations()
  }
  const clear = () => {
    dispose?.()
    dispose = undefined
    // A component can render several top-level nodes (a Dialog is its trigger and its
    // portal's layer), and removing one leaves the others in the native tree.
    for (const mounted of [...container.childList]) removeHostNode(container, mounted)
    container.destroyDocumentElements()
    flush()
    eventHandlers.clear()
  }

  return {
    render(code) {
      if (dispose) {
        clear()
        detach()
        attach()
      }
      container.ensureDocumentElements()
      dispose = universalRender(
        () => createComponent(GpuixContext.Provider, {
          value: {
            renderer,
            mutations,
            subscribeSelection(callback) {
              selectionListeners.add(callback)
              callback(renderer.getSelectedText?.() ?? null)
              syncSelection()
              return () => {
                selectionListeners.delete(callback)
                syncSelection()
              }
            },
            subscribeAppearance(callback) {
              appearanceListeners.add(callback)
              syncAppearance()
              return () => {
                appearanceListeners.delete(callback)
                syncAppearance()
              }
            },
          },
          get children() {
            return code()
          },
        }),
        container.body
      )
      flush()
    },
    flush,
    flushSync(fn) {
      try {
        return fn()
      } finally {
        flush()
      }
    },
    dispatch(event) {
      try {
        return state.dispatch(event)
      } finally {
        flush()
      }
    },
    unmount() {
      clear()
      detach()
    },
  }
}
