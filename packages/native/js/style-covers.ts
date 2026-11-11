/**
 * Which properties a shorthand covers directly, mirroring `COVERS` in `native/src/css/covers.rs`
 * (keep the two the same). Two declarations of overlapping properties are one cascade: the one
 * written later wins, so the order of a style's keys carries meaning.
 */
const DIRECT_COVERS: Readonly<Record<string, readonly string[]>> = {
  padding: ["paddingBlock", "paddingInline", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  paddingBlock: ["paddingTop", "paddingBottom"],
  paddingInline: ["paddingLeft", "paddingRight"],
  margin: ["marginBlock", "marginInline", "marginTop", "marginRight", "marginBottom", "marginLeft"],
  marginBlock: ["marginTop", "marginBottom"],
  marginInline: ["marginLeft", "marginRight"],
  inset: ["insetBlock", "insetInline", "top", "right", "bottom", "left"],
  insetBlock: ["top", "bottom"],
  insetInline: ["left", "right"],
  border: ["borderBlock", "borderInline", "borderTop", "borderRight", "borderBottom", "borderLeft", "borderWidth", "borderColor", "borderStyle"],
  borderBlock: ["borderTop", "borderBottom"],
  borderInline: ["borderLeft", "borderRight"],
  borderTop: ["borderTopWidth", "borderTopColor", "borderTopStyle"],
  borderRight: ["borderRightWidth", "borderRightColor", "borderRightStyle"],
  borderBottom: ["borderBottomWidth", "borderBottomColor", "borderBottomStyle"],
  borderLeft: ["borderLeftWidth", "borderLeftColor", "borderLeftStyle"],
  borderWidth: ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"],
  borderColor: ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor"],
  borderStyle: ["borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle"],
  borderRadius: ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"],
  outline: ["outlineWidth", "outlineStyle", "outlineColor"],
  flex: ["flexGrow", "flexShrink", "flexBasis"],
  flexFlow: ["flexDirection", "flexWrap"],
  placeItems: ["alignItems", "justifyItems"],
  placeContent: ["alignContent", "justifyContent"],
  placeSelf: ["alignSelf", "justifySelf"],
  gap: ["rowGap", "columnGap"],
  overflow: ["overflowX", "overflowY"],
  overscrollBehavior: ["overscrollBehaviorX", "overscrollBehaviorY"],
  container: ["containerType", "containerName"],
  containIntrinsicSize: ["containIntrinsicWidth", "containIntrinsicHeight", "containIntrinsicInlineSize", "containIntrinsicBlockSize"],
  gridArea: ["gridColumn", "gridRow"],
  gridColumn: ["gridColumnStart", "gridColumnEnd"],
  gridRow: ["gridRowStart", "gridRowEnd"],
  transition: ["transitionProperty", "transitionDuration", "transitionTimingFunction", "transitionDelay", "transitionBehavior"],
  animation: ["animationName", "animationDuration", "animationTimingFunction", "animationDelay", "animationIterationCount", "animationDirection", "animationFillMode", "animationPlayState"],
  textDecoration: ["textDecorationLine", "textDecorationStyle", "textDecorationColor", "textDecorationThickness"],
  textBox: ["textBoxTrim", "textBoxEdge"],
  textWrap: ["textWrapMode", "textWrapStyle"],
  mask: ["maskImage", "maskSize", "maskPosition", "maskRepeat", "maskOrigin", "maskClip", "maskMode", "maskComposite", "maskBorder"],
  maskBorder: ["maskBorderSource", "maskBorderSlice", "maskBorderWidth", "maskBorderOutset", "maskBorderRepeat", "maskBorderMode"],
  background: ["backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundOrigin", "backgroundClip"],
}

function coveredBy(shorthand: string, into: Set<string>): void {
  for (const property of DIRECT_COVERS[shorthand] ?? []) {
    if (into.has(property)) continue
    into.add(property)
    coveredBy(property, into)
  }
}

/** The property and everything it covers, through shorthands it covers as well. */
function reach(property: string): Set<string> {
  const reached = new Set([property])
  coveredBy(property, reached)
  return reached
}

const REACH: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.keys(DIRECT_COVERS).map((shorthand) => [shorthand, reach(shorthand)]))

/** Whether declaring `left` and `right` in one style sets some property twice: they are the same, or one covers the other, or both cover a common property (`borderTop` and `borderWidth`). */
export function overlaps(left: string, right: string): boolean {
  if (left === right) return true
  const leftReach = REACH.get(left)
  const rightReach = REACH.get(right)
  if (leftReach === undefined && rightReach === undefined) return false
  const leftSet = leftReach ?? new Set([left])
  const rightSet = rightReach ?? new Set([right])
  for (const property of leftSet) if (rightSet.has(property)) return true
  return false
}
