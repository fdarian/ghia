import type { NativeRenderer } from "../host.js"

/** An optional method of the renderer, bound, or a throw that says what has no support without it. */
export function requiredMethod<Name extends keyof NativeRenderer>(
  renderer: NativeRenderer,
  name: Name,
  consequence: string
): NonNullable<NativeRenderer[Name]> {
  const method = renderer[name]
  if (typeof method !== "function") throw new Error(`This renderer does not support ${name}, so ${consequence}`)
  return (method as (...args: unknown[]) => unknown).bind(renderer) as NonNullable<NativeRenderer[Name]>
}
