export type PopoverKind = "auto" | "manual"

/** The state a `popover` attribute stands for: empty and unknown values are the keywords' defaults, as in the DOM. */
export function popoverKind(attribute: string | null): PopoverKind | null {
  if (attribute === null) return null
  switch (attribute.toLowerCase()) {
    case "":
    case "auto":
    case "hint":
      return "auto"
    default:
      return "manual"
  }
}

/** The value `element.popover` reads: the attribute limited to its known values. */
export function popoverProperty(attribute: string | null): "auto" | "manual" | "hint" | null {
  if (attribute === null) return null
  const lower = attribute.toLowerCase()
  if (lower === "hint") return "hint"
  return popoverKind(attribute)
}
