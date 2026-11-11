import {
  forwardsCustomProp,
  keepWrittenEntries,
  isReservedProp,
  sameMutationValue,
  serializeCustomProp,
} from "@ghia/native/host"
import type { MutationRenderer, Props } from "../types/host.js"

/**
 * The props an element has after the framework commits `newProps` over `oldProps`, when `current`
 * is what the element holds because `setAttribute` or `element.style` wrote to it since
 * `oldProps`. As in the DOM, a prop the commit changes or removes takes the framework's value; one
 * it left as it was keeps the attribute's, and an attribute the framework never set stays. The
 * `style` prop is merged by property, not as a whole: React DOM sets only the properties that
 * changed, and an inline style object is new on every render.
 */
export function keepAttributeWrites(current: Props, oldProps: Props, newProps: Props): Props {
  const merged = (keepWrittenEntries(current, oldProps, newProps) ?? newProps) as Props
  if (current.style === oldProps.style) return merged
  const style = keepWrittenEntries(
    current.style as Record<string, unknown> | undefined,
    oldProps.style as Record<string, unknown> | undefined,
    newProps.style as Record<string, unknown> | undefined
  )
  const withStyle = { ...merged } as Record<string, unknown>
  if (style === undefined) delete withStyle.style
  else withStyle.style = style
  return withStyle as Props
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
