---
'@ghia/native': patch
---

An `IntersectionObserver` (and `onLayout`, `ResizeObserver` and `content-visibility: auto`, which read the same boxes) is swept after the frames that move the rows of a `<virtual-list>` in place, as after a frame that built them: the sweep was a canvas that only a painted frame runs, so a row that a translated frame brought into view was not told of until a frame was built whole.
