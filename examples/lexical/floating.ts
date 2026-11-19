const VERTICAL_GAP = 10
const HORIZONTAL_OFFSET = 5
const OFFSCREEN = 'translate(-10000px, -10000px)'

export function hideFloating(floating: HTMLElement): void {
  floating.style.opacity = '0'
  floating.style.transform = OFFSCREEN
}

/**
 * Puts `floating` above `target`, or below it when there is no room above, inside `bounds`, as the Lexical playground's
 * FloatingTextFormatToolbarPlugin does. `floating` is absolutely positioned at the top left of its parent.
 */
export function positionFloating(target: DOMRect, floating: HTMLElement, bounds: HTMLElement): void {
  const anchor = floating.parentElement
  if (anchor === null) throw new Error('the floating toolbar is not in the document')
  const floatingRect = floating.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const boundsRect = bounds.getBoundingClientRect()

  let top = target.top - floatingRect.height - VERTICAL_GAP
  let left = target.left - HORIZONTAL_OFFSET
  if (top < boundsRect.top) top = target.bottom + VERTICAL_GAP
  if (left + floatingRect.width > boundsRect.right) left = boundsRect.right - floatingRect.width - HORIZONTAL_OFFSET
  if (left < boundsRect.left) left = boundsRect.left + HORIZONTAL_OFFSET

  floating.style.opacity = '1'
  floating.style.transform = `translate(${left - anchorRect.left}px, ${top - anchorRect.top}px)`
}

/** The box of the selected text, or `null` when there is no selection inside `root` or it is only a caret. */
export function selectionRect(root: HTMLElement): DOMRect | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  return range.getBoundingClientRect()
}
