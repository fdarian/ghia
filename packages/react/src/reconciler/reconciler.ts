import React from "react"
import type { ReactNode } from "react"
import ReactReconciler from "react-reconciler"
import type { OpaqueRoot } from "react-reconciler"
import { ConcurrentRoot } from "react-reconciler/constants.js"
import {
  createMutationQueue,
  Element as RuntimeElement,
  installElementSource,
  registerRoot,
  registerWindowDisposer,
  registerWindowFactory,
  runAll,
  runSteps,
  syncWindowEventListeners,
  syncWindowSelectionChange,
} from "@ghia/native/host"
import { GpuixContext, type GpuixContextValue } from "../hooks/use-gpuix.js"
import type {
  Container,
  Instance,
  NativeRenderer,
  PublicInstance,
  RootEventHandlers,
} from "../types/host.js"
import {
  attachRoot,
  detachListeners,
  detachRoot,
  idAllocatorFor,
  unregisterEventHandlers,
} from "./event-registry.js"
import { createDomFactory, releaseDetachedNodes } from "./dom-mutation.js"
import { containerFor, isHostInstance, livePropEntries, stateFor } from "./host-nodes.js"
import {
  destroyDocumentElements,
  hostConfig,
  installDocumentElements,
  publicInstanceById,
} from "./host-config.js"
import { restoreControlledState } from "./controlled-state.js"
import { releaseMotionBindings } from "./motion-bindings.js"

// Cast to any because @types/react-reconciler is out of date with react-reconciler 0.31.0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reconciler = ReactReconciler(hostConfig as any)

/**
 * Register with the React DevTools global hook.
 *
 * This is not only for DevTools, and it is not optional. React Fast Refresh
 * reaches a renderer through the same hook: `react-refresh` patches
 * `hook.inject`, keeps the `scheduleRefresh` and `setRefreshHandler` helpers
 * this call passes in, and drives hot updates through them.
 *
 * Drop this call and there is **no error and no page reload**. Bun still marks
 * the edited module self-accepting and still calls `performReactRefresh()`,
 * which iterates zero mounted roots and schedules nothing. The bundle updates
 * and the painted UI silently stays stale.
 *
 * The hook has to already exist when this module evaluates. Bun's HMR runtime
 * calls `injectIntoGlobalHook(window)` during bundle init, so it does in the
 * dev server, and `injectIntoDevTools()` is a no-op returning `false` in plain
 * Node. Do not test that return value: it ends in `hook.checkDCE ? true : false`
 * and `react-refresh` installs no `checkDCE`, so a working injection still
 * reports `false`. `fast-refresh.test.tsx` asserts the observable behaviour.
 */
try {
  // @ts-expect-error the types for `react-reconciler` are not up to date with the library
  reconciler.injectIntoDevTools()
} catch {
  // No DevTools hook in this process.
}

const _r = reconciler as typeof reconciler & {
  flushSyncFromReconciler?: typeof reconciler.flushSync
}
export const flushSync = _r.flushSyncFromReconciler ?? _r.flushSync

export interface Root {
  render: (node: ReactNode) => void
  unmount: () => void
}

/**
 * A root on a window, as `render()` makes for the first one: `createRoot(renderer)` is the window `renderer`
 * owns, and `createRoot(container)` is React DOM's, a root in an element of a mounted window (`w.document.body`
 * of the window `window.open('')` gave) that renders beside what the element holds.
 */
export function createRoot(renderer: NativeRenderer, rootEventHandlers?: RootEventHandlers): Root
export function createRoot(container: PublicInstance, options?: Pick<RootEventHandlers, "onUncaughtError">): Root
export function createRoot(
  target: NativeRenderer | PublicInstance,
  rootEventHandlers: RootEventHandlers = {}
): Root {
  // Any element goes to `createElementRoot`, which throws for one that is in no mounted window: a closed window's body must not become a window root.
  if (target instanceof RuntimeElement) return createElementRoot(target as unknown as Instance, rootEventHandlers)
  return createWindowRoot(target as NativeRenderer, rootEventHandlers)
}

function createElementRoot(
  element: Instance,
  options: Pick<RootEventHandlers, "onUncaughtError">
): Root {
  // A stand-in element (the body of a closed window) or another adapter's element is no host instance: it has no window to mount in.
  if (!isHostInstance(element) || !stateFor(element).mounted || !element.isConnected) {
    throw new TypeError("createRoot(container) needs an element in the tree of a window with a mounted root")
  }
  const windowContainer = containerFor(element)
  // A container of its own: the portal into `element` has `containerInfo` by identity, and a root must not share it.
  const rootContainer = Object.assign(Object.create(windowContainer) as Container, { portalTarget: element })
  const onUncaughtError = options.onUncaughtError ?? windowContainer.onUncaughtError
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let opaque: OpaqueRoot | null = (reconciler.createContainer as any)(
    rootContainer,
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    onUncaughtError,
    console.error,
    console.error,
    null
  )
  // One object for the life of the root, as in a window's root.
  const contextValue: GpuixContextValue = {
    renderer: windowContainer.nativeRenderer,
    mutations: windowContainer.renderer,
  }
  const unmount = (): void => {
    windowContainer.elementRoots.delete(unmount)
    const active = opaque
    if (!active) return
    opaque = null
    // Sync, like a window's root: a late unmount destroys remounted ids.
    flushSync(() => {
      reconciler.updateContainer(null, active, null, () => {})
    })
  }
  windowContainer.elementRoots.add(unmount)
  return {
    render: (node): void => {
      if (!opaque) throw new Error("Cannot render an unmounted GPUIX root")
      reconciler.updateContainer(
        React.createElement(GpuixContext.Provider, { value: contextValue }, node),
        opaque,
        null,
        () => {}
      )
    },
    unmount,
  }
}

function createWindowRoot(
  renderer: NativeRenderer,
  rootEventHandlers: RootEventHandlers
): Root {
  let container: OpaqueRoot | null = null
  const ids = idAllocatorFor(renderer)
  const onUncaughtError =
    rootEventHandlers.onUncaughtError ??
    ((error: Error) => {
      console.error(error)
    })
  let gpuixContainer!: Container
  const batchedRenderer = createMutationQueue(renderer, (destroyedIds) => {
    for (const id of destroyedIds) {
      unregisterEventHandlers(gpuixContainer.eventHandlers, id)
      const instance = gpuixContainer.instances.get(id)
      if (instance) detachListeners(instance)
      gpuixContainer.instances.delete(id)
    }
    releaseMotionBindings(gpuixContainer, destroyedIds)
  }, (flush) => {
    // Code that changes the tree outside a React commit (`document.createElement`, `appendChild`)
    // has no commit to flush it.
    queueMicrotask(() => {
      // Apart, so a throw while releasing detached nodes never skips the flush.
      try {
        releaseDetachedNodes(gpuixContainer)
      } catch (error) {
        onUncaughtError(error instanceof Error ? error : new Error(String(error)), {})
      }
      try {
        flush()
      } catch (error) {
        onUncaughtError(error instanceof Error ? error : new Error(String(error)), {})
      }
    })
  })
  const documentless: Omit<Container, "html" | "head" | "body"> = {
    nativeRenderer: renderer,
    renderer: batchedRenderer,
    ids,
    eventHandlers: new Map(),
    motionBindings: new Map(),
    motionReleases: [],
    instances: new Map(),
    elementRoots: new Set(),
    windowKeyEventHandlers: rootEventHandlers,
    windowKeyEventId: 0,
    windowSelectionEventId: 0,
    windowAppearanceEventId: 0,
    onEvent: rootEventHandlers.onEvent,
    onUncaughtError,
  }
  // Before `<html>` is queued: a root refused here (a renderer has one) must leave nothing in its queue,
  // which `flushPendingMutations` would send over the live root's tree.
  // The flush stands in for the microtask checkpoint a browser runs before it renders.
  attachRoot(
    renderer,
    documentless as Container,
    (run) => flushSync(run),
    (event) => restoreControlledState(gpuixContainer, event)
  )
  try {
    gpuixContainer = installDocumentElements(documentless)
  } catch (error) {
    detachRoot(renderer, documentless as Container)
    throw error
  }
  batchedRenderer.setElementSource({
    forEachElement(visit) {
      for (const instance of gpuixContainer.instances.values()) {
        visit(instance.nativeId, instance.elementType, livePropEntries(instance))
      }
    },
  })
  // Sent on every root, so a remount without the option restores the default.
  batchedRenderer.setKeyboardFocusDim(rootEventHandlers.keyboardFocusDim !== false)
  const windowKeyEventId = gpuixContainer.windowKeyEventId
  const windowSelectionEventId = gpuixContainer.windowSelectionEventId
  const windowAppearanceEventId = gpuixContainer.windowAppearanceEventId
  let stopWindowEventListeners: (() => void) | undefined
  let stopSelectionChange: (() => void) | undefined
  let stopElementSource: (() => void) | undefined
  try {
    renderer.setWindowKeyEvents?.(
      // Always on: the Tab and Escape defaults run on the key event, and
      // `window` listeners can be added at any time.
      true,
      true,
      windowKeyEventId
    )
    stopSelectionChange = syncWindowSelectionChange(
      renderer,
      windowSelectionEventId,
      () => Boolean(rootEventHandlers.onSelectionChange)
    ).stop
    renderer.setWindowAppearanceChange?.(
      Boolean(rootEventHandlers.onAppearanceChange),
      windowAppearanceEventId
    )
    stopWindowEventListeners = syncWindowEventListeners(renderer)
    stopElementSource = installElementSource(
      renderer,
      (id) => publicInstanceById(gpuixContainer, id),
      () => ({ html: gpuixContainer.html, head: gpuixContainer.head, body: gpuixContainer.body }),
      createDomFactory(gpuixContainer)
    )
  } catch (error) {
    detachRoot(renderer, gpuixContainer)
    throw error
  }

  const unregister = registerRoot(() => cleanup())
  // What `window.open` gives an app: the window gets a root of its own, and the app renders into its `document.body`.
  // `createWindowRoot` registers the window disposer of the popup's root itself, so the factory returns none.
  const unregisterWindowFactory = registerWindowFactory(renderer, (opened) => {
    createWindowRoot(opened, { onUncaughtError: rootEventHandlers.onUncaughtError })
  })
  // The window going away (the user closed it, `close()`, the app ending) unmounts the root, the first window's included.
  const unregisterWindowDisposer = registerWindowDisposer(renderer, () => cleanup())

  // Every step runs even when one throws: a failed unmount must still release `<html>`, the root and the listeners.
  const cleanup = (): void => {
    unregister()
    unregisterWindowFactory()
    unregisterWindowDisposer()
    runSteps([
      () => runAll([...gpuixContainer.elementRoots], (unmountElementRoot) => unmountElementRoot(), "Unmounting the roots in elements failed"),
      () => {
        const activeContainer = container
        if (!activeContainer) return
        container = null
        // Must be sync. A late unmount destroy()s remounted ids and the window goes black.
        flushSync(() => {
          reconciler.updateContainer(null, activeContainer, null, () => {})
        })
      },
      () => destroyDocumentElements(gpuixContainer),
      () => {
        if (!detachRoot(renderer, gpuixContainer)) return
        runSteps([
          () => renderer.setWindowKeyEvents?.(false, false, windowKeyEventId),
          () => stopWindowEventListeners?.(),
          () => stopElementSource?.(),
          () => stopSelectionChange?.(),
          () => renderer.setWindowAppearanceChange?.(false, windowAppearanceEventId),
        ], "Releasing the window listeners failed")
      },
    ], "Unmounting failed")
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container = (reconciler.createContainer as any)(
    gpuixContainer,
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    onUncaughtError,
    console.error,
    console.error,
    null
  )

  // One object for the life of the root. A fresh `{ renderer }` per `render()`
  // call is a context change, which re-renders every `useGpuix()` consumer, and
  // through them busts `memo` below it, on every re-render of the root.
  const contextValue: GpuixContextValue = { renderer, mutations: batchedRenderer }

  return {
    render: (node): void => {
      const activeContainer = container
      if (!activeContainer) {
        throw new Error("Cannot render an unmounted GPUIX root")
      }
      reconciler.updateContainer(
        React.createElement(
          GpuixContext.Provider,
          { value: contextValue },
          node
        ),
        activeContainer,
        null,
        () => {}
      )
    },

    unmount: cleanup,
  }
}
