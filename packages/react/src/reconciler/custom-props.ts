import {
  attributesOfProps,
  forwardsCustomProp,
  isNotNativeAttribute,
  isReservedProp,
  sameMutationValue,
  serializeCustomProp,
} from "@ghia/native/host"
import type { MutationRenderer, Props } from "../types/host.js"

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

/** A handler or an object is no attribute, so one is as good as another: an inline handler is new on every render. */
function isNoAttributeValue(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null)
}

function sameAttributeProp(previous: unknown, next: unknown): boolean {
  return previous === next || (isNoAttributeValue(previous) && isNoAttributeValue(next))
}

/** Whether a prop that can be an attribute differs, compared in place: most commits change none, and this allocates nothing. */
function attributePropsDiffer(oldProps: Props, newProps: Props): boolean {
  const previous = oldProps as unknown as Record<string, unknown>
  const next = newProps as unknown as Record<string, unknown>
  for (const key in next) {
    if (!isNotNativeAttribute(key) && !sameAttributeProp(previous[key], next[key])) return true
  }
  for (const key in previous) {
    if (!(key in next) && !isNotNativeAttribute(key) && !sameAttributeProp(previous[key], undefined)) return true
  }
  return false
}

export function diffAttributes(
  renderer: MutationRenderer,
  id: number,
  type: string,
  oldProps: Props,
  newProps: Props
): void {
  if (!renderer.forwardsAttributes || !attributePropsDiffer(oldProps, newProps)) return
  const previous = attributesOfProps(Object.entries(oldProps), type)
  const next = attributesOfProps(Object.entries(newProps), type)
  for (const [name, text] of next) {
    if (previous.get(name) !== text) renderer.setAttribute(id, name, text)
  }
  for (const name of previous.keys()) {
    if (!next.has(name)) renderer.setAttribute(id, name, null)
  }
}
