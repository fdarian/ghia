import type { JSX } from "solid-js"
import { GpuixRenderer, type WindowOptions } from "@ghia/native"
import { isWebBuild, type NativeRenderer, type RootEventHandlers } from "@ghia/native/host"
import {
  createNativeRenderer,
  installBrowserAutomation,
  startFrameLoop,
  type FrameLoop,
  type FrameLoopOptions,
  type WindowFontsOption,
} from "@ghia/native/runtime"
import { isHostElement } from "./host.js"
import { createRoot, renderIntoElement, type Root } from "./root.js"
import { reportUncaughtError } from "./uncaught-error.js"

const RENDER_HOSTS = Symbol.for("@ghia/solid/render-hosts")

interface RenderSlot {
  renderer?: NativeRenderer
  root?: Root
  loop?: FrameLoop
  /** The latest render's handler: the renderer outlives the render that created it. */
  onUncaughtError?: RenderOptions["onUncaughtError"]
}

export interface RenderOptions
  extends WindowOptions,
    WindowFontsOption,
    RootEventHandlers {
  renderer?: NativeRenderer
  debugFrameOverlay?: "hidden" | "minimal" | "full"
  /**
   * How the native event loop is pumped. On macOS the default is paced by the
   * display link; `frameMs` opts into polling with a timer instead.
   */
  frameLoop?: Pick<FrameLoopOptions, "frameMs">
}

export function createRenderer(
  onEvent?: (event: import("@ghia/native").EventPayload) => void
): GpuixRenderer {
  return createNativeRenderer({
    onEvent,
    onError: (error) => console.error("[gpuix-solid] native event error", error),
  })
}

/** One slot for each renderer a call to `render` mounts on: the window it opens itself, and each renderer it is given. */
interface RenderHosts {
  /** The slot of `render` calls that name no renderer, which own the window and its frame loop. */
  own?: RenderSlot
  readonly slots: Set<RenderSlot>
}

function hosts(): RenderHosts {
  const global = globalThis as typeof globalThis & { [RENDER_HOSTS]?: RenderHosts }
  return global[RENDER_HOSTS] ??= { slots: new Set() }
}

function slotFor(injected: NativeRenderer | undefined): RenderSlot {
  const all = hosts()
  if (injected === undefined) {
    all.own ??= {}
    all.slots.add(all.own)
    return all.own
  }
  for (const known of all.slots) if (known.renderer === injected) return known
  const created: RenderSlot = { renderer: injected }
  all.slots.add(created)
  return created
}

/**
 * Mount Solid on a window of its own, as the first call does: later calls under `bun --hot` remount on the same window.
 *
 * With an element of a window's document instead of options, `render(code, container)` mounts `code` as children of
 * that element, as `solid-js/web`'s `render(code, element)` does (typically `window.open('').document.body`), and
 * returns the function that disposes it.
 */
export function render(code: () => JSX.Element, options?: RenderOptions): Root
export function render(code: () => JSX.Element, container: Element): () => void
export function render(code: () => JSX.Element, optionsOrContainer: RenderOptions | Element = {}): Root | (() => void) {
  if (isHostElement(optionsOrContainer)) return renderIntoElement(code, optionsOrContainer)
  return renderWindow(code, optionsOrContainer as RenderOptions)
}

function renderWindow(code: () => JSX.Element, options: RenderOptions): Root {
  const {
    renderer: injected,
    debugFrameOverlay,
    frameLoop,
    onEvent,
    onKeyDown,
    onKeyUp,
    onSelectionChange,
    onAppearanceChange,
    tabNavigation,
    keyboardFocusDim,
    onUncaughtError,
    ...windowOptions
  } = options
  const host = slotFor(injected)
  host.onUncaughtError = onUncaughtError
  if (!host.renderer) {
    host.renderer = createNativeRenderer({
      onError(error) {
        reportUncaughtError(host, error)
      },
    })
    if (host.renderer instanceof GpuixRenderer) {
      host.renderer.init(windowOptions)
    }
  }
  host.root?.unmount()
  host.root = createRoot(host.renderer, {
    onEvent,
    onKeyDown,
    onKeyUp,
    onSelectionChange,
    onAppearanceChange,
    tabNavigation,
    keyboardFocusDim,
    onUncaughtError,
  })
  if (!injected && host.renderer instanceof GpuixRenderer && !host.loop) {
    host.loop = startFrameLoop(host.renderer, {
      ...frameLoop,
      onTerminated: () => {
        if (typeof process !== "undefined") process.exit(0)
      },
      onError: (error) => console.error("[gpuix-solid] frame error", error),
    })
  }
  if (
    isWebBuild &&
    host.renderer instanceof GpuixRenderer &&
    !Reflect.has(globalThis, "gpuix")
  ) {
    installBrowserAutomation(host.renderer).then(
      (automation) => {
        if (!Reflect.has(globalThis, "gpuix")) Reflect.set(globalThis, "gpuix", automation)
      },
      (error) => console.error("[gpuix-solid] automation failed", error)
    )
  }
  if (debugFrameOverlay) host.renderer.setDebugFrameOverlay?.(debugFrameOverlay)
  host.root.render(code)
  return host.root
}

export function resetRender(): void {
  const global = globalThis as typeof globalThis & { [RENDER_HOSTS]?: RenderHosts }
  const all = global[RENDER_HOSTS]
  if (all === undefined) return
  delete global[RENDER_HOSTS]
  for (const host of all.slots) {
    host.loop?.stop()
    host.root?.unmount()
  }
}
