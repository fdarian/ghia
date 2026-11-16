import { invalidateComputedStyles } from "../computed-style.js"
import type { NativeRenderer } from "../host.js"

/**
 * An optional method of the renderer that changes the state native holds and restyles it (a toggle,
 * a script write, a restore), bound, or a throw that says what has no support without it. No batch
 * follows such a change, so the call ends the computed styles read before it.
 */
export function requiredWriter<Name extends keyof NativeRenderer>(
  renderer: NativeRenderer,
  name: Name,
  consequence: string
): NonNullable<NativeRenderer[Name]> {
  const method = renderer[name]
  if (typeof method !== "function") throw new Error(`This renderer does not support ${name}, so ${consequence}`)
  const write = (method as (...args: unknown[]) => unknown).bind(renderer)
  return ((...args: unknown[]) => {
    try {
      return write(...args)
    } finally {
      invalidateComputedStyles()
    }
  }) as NonNullable<NativeRenderer[Name]>
}
