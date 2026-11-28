---
"@ghia/native": patch
---

macOS: a wheel tick over a `<virtual-list>` is a translate with a screen reader connected too (VoiceOver users drew every tick as a whole frame): the translate moves the bounds of the rows' accessibility nodes, takes the nodes of rows that leave out of the tree, puts those of rows that come in, and tells the platform of what changed. A tree it cannot edit is a frame built whole and counted in `getPatchCounters().scrollPatch.applyDeclines.A11y`: a row that leaves or comes in has an `id` that another element's `aria-labelledby`, `aria-describedby`, `aria-controls` or the like points at (a `<label for>` points at its control's `id`), a row that comes in has such an attribute itself, or a row that leaves or comes in holds the focus; an `id` that nothing points at costs nothing. The test renderer's `getShownA11yTree()` reads the tree of the frame drawn last without the flush that draws a frame built whole over it
