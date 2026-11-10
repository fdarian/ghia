import type { ReactNode } from "react"
import {
  TestRenderer,
  hasNativeTestRenderer,
  type TestWindowOptions,
} from "@ghia/native/testing"
import { createRoot, flushSync, type Root } from "./reconciler/reconciler.js"
import type { EventPayload } from "@ghia/native"
import type { RootEventHandlers } from "@ghia/native/host"
import { handleGpuixEvent } from "./reconciler/event-registry.js"

export * from "@ghia/native/testing"

export interface TestRoot {
  root: Root
  renderer: TestRenderer
  render: (node: ReactNode) => void
  unmount: () => void
}

export function createTestRoot(
  options: TestWindowOptions & Pick<RootEventHandlers, "onUncaughtError"> = {}
): TestRoot {
  let renderer!: TestRenderer
  // Only the queued events are wrapped here: synchronous ones take the handler a live window installs.
  renderer = new TestRenderer({
    ...options,
    dispatchEvent: (event: EventPayload) => {
      flushSync(() => handleGpuixEvent(event, renderer))
    },
  })
  const root = createRoot(renderer, {
    onKeyDown: options.onKeyDown,
    onKeyUp: options.onKeyUp,
    onSelectionChange: options.onSelectionChange,
    onAppearanceChange: options.onAppearanceChange,
    tabNavigation: options.tabNavigation,
    keyboardFocusDim: options.keyboardFocusDim,
    onUncaughtError: options.onUncaughtError,
  })
  const render = (node: ReactNode): void => {
    flushSync(() => root.render(node))
    renderer.flush()
  }
  const unmount = (): void => {
    root.unmount()
    renderer.dispose()
  }
  return { root, renderer, render, unmount }
}

export { TestRenderer, hasNativeTestRenderer }
