import type { NativeRenderer } from "./host.js"

const MOUNTED_KEY = Symbol.for("@ghia/native/mounted-renderer")

/** Mount order, oldest first. Shared through `globalThis` like the renderer states. */
export function mountedRenderers(): NativeRenderer[] {
  const existing = Reflect.get(globalThis, MOUNTED_KEY) as NativeRenderer[] | undefined
  if (existing) return existing
  const created: NativeRenderer[] = []
  Reflect.set(globalThis, MOUNTED_KEY, created)
  return created
}

/**
 * The renderer of the most recently mounted root that is still mounted, which
 * is "the window" for code that has no component to ask, such as the global
 * `matchMedia` and `document.body`.
 */
export function mountedRenderer(): NativeRenderer | undefined {
  return mountedRenderers().at(-1)
}
