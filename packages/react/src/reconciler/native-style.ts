import { splitMotionStyle } from "@ghia/native/host"
import type { Props } from "../types/host.js"

/**
 * The style a hidden element keeps: its own, minus the states, plus `display: none !important`,
 * which is what React DOM writes, so a sheet rule cannot show what Suspense hides.
 */
export function hiddenStyle(style: Props["style"]) {
  // Hover and active go, because a hidden element must stay hidden. A hover
  // style that sets `display` would otherwise show an element React asked to hide.
  const base = { ...splitMotionStyle(style).style }
  delete base.hover
  delete base.active
  return { ...base, display: "none !important" }
}
