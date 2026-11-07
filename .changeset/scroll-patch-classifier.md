---
'@ghia/native': patch
---

`getPatchCounters().scrollPatch` says how the frames drawn after a wheel event over a `<virtual-list>` would have been drawn by moving the rows of the frame shown instead of building the page: `frames`, `eligible`, `mispredicted`, `hoverOnly` and `reasons` (the first reason a frame was not a translate: `Edited`, `Membership`, `Hover`, `Place`, `Region`, `Clip`, `Focus`, `A11y`, `ScrollAnimation`, `NotRelocatable`, `Other`). Every frame is still drawn whole and nothing paints differently; the first step of drawing a list scroll without the page. `GPUIX_SCROLL_PATCH_OFF=1` (or `setScrollPatchEnabled(false)` on the test renderer) turns the bookkeeping off.
