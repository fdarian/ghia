import { splitMotionStyle } from "@ghia/native/host"
import type { Props } from "../types/host.js"

/** The style a hidden element keeps: its own, minus the states, plus `visibility: hidden`. */
export function hiddenStyle(style: Props["style"]) {
  // Hover and active go, because a hidden element must stay hidden. A hover
  // style that sets `visibility` would otherwise paint an element React
  // asked to hide.
  const base = { ...splitMotionStyle(style).style }
  delete base.hover
  delete base.active
  return { ...base, visibility: "hidden" }
}

/** What native is given for an element's `style` prop. */
export function nativeStyleOf(style: Props["style"], hidden: boolean) {
  return hidden ? hiddenStyle(style) : (splitMotionStyle(style).style ?? {})
}
