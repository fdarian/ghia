import type { JSX } from "solid-js"
import { GpuixRenderer, type WindowOptions } from "@ghia/native"
import {
  bindRenderSlot,
  Element as RuntimeElement,
  isWebBuild,
  renderSlotFor,
  resetRenderSlots,
  type NativeRenderer,
  type RenderSlot as BaseRenderSlot,
  type RootEventHandlers,
} from "@ghia/native/host"
import {
  createNativeRenderer,
  installBrowserAutomation,
  startFrameLoop,
  type FrameLoop,
  type FrameLoopOptions,
  type WindowFontsOption,
} from "@ghia/native/runtime"
import { createRoot, renderIntoElement, type Root } from "./root.js"
import { reportUncaughtError } from "./uncaught-error.js"

interface RenderSlot extends BaseRenderSlot {
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
  // Any element goes to `renderIntoElement`, which throws for one that is in no mounted window: the body of a closed window must not mount the app again.
  if (optionsOrContainer instanceof RuntimeElement) return renderIntoElement(code, optionsOrContainer as Element)
  return renderWindow(code, optionsOrContainer as RenderOptions)
}

function createWindowRenderer(host: RenderSlot, windowOptions: WindowOptions & WindowFontsOption): NativeRenderer {
  const created = createNativeRenderer({
    onError(error) {
      reportUncaughtError(host, error)
    },
  })
  bindRenderSlot(host, created)
  if (created instanceof GpuixRenderer) {
    created.init(windowOptions)
  }
  return created
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
  const host = renderSlotFor<RenderSlot>(injected)
  host.onUncaughtError = onUncaughtError
  const renderer = host.renderer ?? createWindowRenderer(host, windowOptions)
  // After the mount, not before: the loop's first tick draws the window, and
  // started earlier it presents an empty frame (~50 ms) before the content. In a
  // `finally` so a mount that throws still leaves the opened window ticking.
  try {
    host.root?.unmount()
    host.root = createRoot(renderer, {
      onEvent,
      onKeyDown,
      onKeyUp,
      onSelectionChange,
      onAppearanceChange,
      tabNavigation,
      keyboardFocusDim,
      onUncaughtError,
    })
    if (
      isWebBuild &&
      renderer instanceof GpuixRenderer &&
      !Reflect.has(globalThis, "gpuix")
    ) {
      installBrowserAutomation(renderer).then(
        (automation) => {
          if (!Reflect.has(globalThis, "gpuix")) Reflect.set(globalThis, "gpuix", automation)
        },
        (error) => console.error("[gpuix-solid] automation failed", error)
      )
    }
    if (debugFrameOverlay) renderer.setDebugFrameOverlay?.(debugFrameOverlay)
    host.root.render(code)
  } finally {
    if (!injected && renderer instanceof GpuixRenderer && !host.loop) {
      host.loop = startFrameLoop(renderer, {
        ...frameLoop,
        onTerminated: () => {
          if (typeof process !== "undefined") process.exit(0)
        },
        onError: (error) => console.error("[gpuix-solid] frame error", error),
      })
    }
  }
  return host.root
}

export function resetRender(): void {
  resetRenderSlots()
}
