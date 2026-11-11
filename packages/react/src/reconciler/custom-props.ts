import {
  forwardsCustomProp,
  isReservedProp,
  sameMutationValue,
  serializeCustomProp,
} from "@ghia/native/host"
import type { MutationRenderer, Props } from "../types/host.js"

/**
 * The props an element has after the framework commits `newProps` over `oldProps`, when `current`
 * is what the element holds because `setAttribute` wrote to it since `oldProps`. As in the DOM, a
 * prop the commit changes or removes takes the framework's value; one it left as it was keeps the
 * attribute's, and an attribute the framework never set stays.
 */
export function keepAttributeWrites(current: Props, oldProps: Props, newProps: Props): Props {
  const written = current as Record<string, unknown>
  const before = oldProps as Record<string, unknown>
  const after = newProps as Record<string, unknown>
  const merged: Record<string, unknown> = { ...after }
  for (const key of new Set([...Object.keys(written), ...Object.keys(before)])) {
    const hadIt = key in before
    const wroteIt = key in written
    if (wroteIt === hadIt && Object.is(written[key], before[key])) continue
    const committed = hadIt ? !(key in after) || !Object.is(before[key], after[key]) : key in after
    if (committed) continue
    if (wroteIt) merged[key] = written[key]
    else delete merged[key]
  }
  return merged as Props
}

/**
 * Diff and send changed custom props to Rust.
 *
 * Compared by value after serialization: a handler or an inline object is new on
 * every render, and a function serializes to `null` either way, so resending it
 * would only make Rust parse and discard the same value again.
 */
export function diffCustomProps(
  renderer: MutationRenderer,
  id: number,
  type: string,
  oldProps: Props,
  newProps: Props
): void {
  const previous = oldProps as Record<string, unknown>
  const next = newProps as Record<string, unknown>
  // Updated or added props
  for (const key in next) {
    if (isReservedProp(key)) continue
    if (!forwardsCustomProp(type, key)) continue
    const value = next[key]
    const oldValue = previous[key]
    if (value === oldValue) continue
    const serialized = serializeCustomProp(value as Parameters<typeof serializeCustomProp>[0])
    if (
      key in previous &&
      sameMutationValue(
        serializeCustomProp(oldValue as Parameters<typeof serializeCustomProp>[0]),
        serialized
      )
    ) {
      continue
    }
    renderer.setCustomProp(id, key, serialized)
  }
  // Removed props
  for (const key in previous) {
    if (isReservedProp(key)) continue
    if (!forwardsCustomProp(type, key)) continue
    if (!(key in next)) renderer.setCustomProp(id, key, null)
  }
}
