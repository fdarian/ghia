import { createComponent, createContext, useContext, type JSX } from "solid-js"
import type { EventPayload } from "@ghia/native"
import {
  createMutationQueue,
  createRendererState,
  installElementSource,
  runAll,
  runSteps,
  runThenAlways,
  runMotionReleases,
  syncWindowEventListeners,
  syncWindowSelectionChange,
  unregisterEventHandlers,
} from "@ghia/native/host"
import { registerRoot, registerWindowDisposer, registerWindowFactory, toAppearance } from "@ghia/native/host"
import type {
  Appearance,
  MutationRenderer,
  NativeRenderer,
  RendererRootBinding,
  RootEvent,
  RootEventHandlers,
} from "@ghia/native/host"
import {
  createHostElement,
  createHostText,
  HostFragment,
  HostRoot,
  isHostElement,
  removeHostNode,
  type HostElement,
  type HostNode,
} from "./host.js"
import { universalRender } from "./universal.js"
import { reportUncaughtError } from "./uncaught-error.js"

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

/** What mounts code into an element of a window's tree: the root that window's `<body>` belongs to. */
const elementMounters = new WeakMap<HostRoot, (element: HostElement, code: () => JSX.Element) => () => void>()

/**
 * Mounts `code` as children of `element`, an element of a mounted window, as `solid-js/web`'s
 * `render(code, element)` does, with the window's `useGpuix()` around it. The returned function
 * disposes it and removes what it rendered; the window's root disposes it too when it unmounts.
 */
export function renderIntoElement(code: () => JSX.Element, element: Element): () => void {
  // A stand-in element (the body of a closed window) or another adapter's element is no host element: it has no window to mount in.
  if (isHostElement(element) && element.mounted && element.root !== null) {
    const mount = elementMounters.get(element.root)
    if (mount !== undefined) return mount(element, code)
  }
  throw new TypeError("render() mounts into an element of a window that has a mounted root; this element is in none")
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
      // Apart, so a throw while releasing removed nodes never skips the flush, and a failed flush is reported too.
      try {
        container.finishRemovals()
      } catch (error) {
        reportUncaughtError(rootHandlers, error)
      }
      try {
        flush()
      } catch (error) {
        reportUncaughtError(rootHandlers, error)
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
      for (const node of container.elements.values()) visit(node.nativeId, node.elementType, node.props)
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
      schedule: (run) => runThenAlways(run, flush, "Running scheduled work failed"),
    })
    // After `state.attach`, which refuses a second root: `<html>` queued before that would sit in a registered queue,
    // and `flushPendingMutations` would send it over the live root's tree.
    try {
      container.ensureDocumentElements()
    } catch (error) {
      detach()
      throw error
    }
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
      () => ({ html: container.html, head: container.head, body: container.body }),
      { createElement: createHostElement, createTextNode: createHostText, createDocumentFragment: () => new HostFragment() }
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
  const unregister = registerRoot(() => root.unmount())
  // What `window.open` gives an app: the window gets a root of its own, and the app renders into its `document.body`.
  // `createRoot` registers the window disposer of the popup's root itself, so the factory returns none.
  const unregisterWindowFactory = registerWindowFactory(renderer, (opened) => {
    createRoot(opened, { onUncaughtError: rootHandlers.onUncaughtError })
  })
  // The window going away (the user closed it, `close()`, the app ending) unmounts the root, the first window's included.
  const unregisterWindowDisposer = registerWindowDisposer(renderer, () => root.unmount())
  const elementRenders = new Set<() => void>()
  elementMounters.set(container, (element, code) => {
    // Only what this render put in the element goes when it is disposed: another render's nodes, a portal's and the app's own stay.
    const owned = new Set<HostNode>()
    const disposeTree = universalRender(
      () => createComponent(GpuixContext.Provider, {
        value: context(),
        get children() {
          return code()
        },
      }),
      element,
      { marker: null, owned }
    )
    const stop = () => {
      if (!elementRenders.delete(stop)) return
      runSteps([
        disposeTree,
        () => runAll([...owned].filter((node) => element.childList.includes(node)), (node) => removeHostNode(element, node), "Removing nodes failed"),
        flush,
      ], "Disposing the render failed")
    }
    elementRenders.add(stop)
    flush()
    return stop
  })
  // The release and the batch are separate steps: a throw in the first must not skip the second.
  const flush = () => {
    runSteps([
      () => container.finishRemovals(),
      () => mutations.flushMutations(),
    ], "Flushing failed")
  }
  // Every step runs even when one throws, so a failed teardown still releases `<html>` and the handlers.
  const clear = () => {
    runSteps([
      () => runAll([...elementRenders], (stop) => stop(), "Disposing the renders into elements failed"),
      () => {
        // Cleared first: a throwing `onCleanup` must not leave the tree to be disposed, and throw, again.
        const disposeTree = dispose
        dispose = undefined
        disposeTree?.()
      },
      // A component can render several top-level nodes (a Dialog is its trigger and its
      // portal's layer), and removing one leaves the others in the native tree.
      () => runAll([...container.childList], (mounted) => removeHostNode(container, mounted), "Removing nodes failed"),
      () => container.destroyDocumentElements(),
      flush,
      () => eventHandlers.clear(),
    ], "Clearing the root failed")
  }

  const context = (): GpuixContextValue => ({
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
  })

  const root: Root = {
    render(code) {
      if (dispose) runSteps([clear, detach, attach], "Rendering again failed")
      container.ensureDocumentElements()
      dispose = universalRender(
        () => createComponent(GpuixContext.Provider, {
          value: context(),
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
      return runThenAlways(fn, flush, "flushSync failed")
    },
    dispatch(event) {
      return runThenAlways(() => state.dispatch(event), flush, "Dispatching the event failed")
    },
    unmount() {
      unregister()
      unregisterWindowFactory()
      unregisterWindowDisposer()
      runSteps([clear, detach], "Unmounting failed")
    },
  }
  return root
}
