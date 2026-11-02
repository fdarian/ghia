import type { JSX } from "solid-js"
import {
  TestRenderer,
  hasNativeTestRenderer,
  type TestWindowOptions,
} from "@ghia/native/testing"
import { createRendererState } from "@ghia/native/host"
import { createRoot, type Root } from "./root.js"

export * from "@ghia/native/testing"

export interface TestRoot {
  root: Root
  renderer: TestRenderer
  render(code: () => JSX.Element): void
  flushSync<Value>(fn: () => Value): Value
  unmount(): void
}

export function createTestRoot(options: TestWindowOptions = {}): TestRoot {
  let root!: Root
  const renderer = new TestRenderer({
    ...options,
    dispatchEvent: (event) => root.dispatch(event),
    dispatchSyncEvent: (event) =>
      // `attach` runs inside the frame, where no renderer call can be made (see `<nativeview>`): a state write
      // in `onAttach` is a later batch, as with the live renderer, and not flushed at the end of the event.
      event.eventType === "attach"
        ? createRendererState(renderer).dispatchSync(event)
        : root.dispatchSync(event),
  })
  root = createRoot(renderer, {
    onKeyDown: options.onKeyDown,
    onKeyUp: options.onKeyUp,
    onSelectionChange: options.onSelectionChange,
    onAppearanceChange: options.onAppearanceChange,
    tabNavigation: options.tabNavigation,
    keyboardFocusDim: options.keyboardFocusDim,
  })
  return {
    root,
    renderer,
    render(code) {
      root.render(code)
      renderer.flush()
    },
    flushSync(fn) {
      const value = root.flushSync(fn)
      renderer.flush()
      return value
    },
    unmount() {
      root.unmount()
      renderer.flush()
      renderer.dispose()
    },
  }
}

export { TestRenderer, hasNativeTestRenderer }
