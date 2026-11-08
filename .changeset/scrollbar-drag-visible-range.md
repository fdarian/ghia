---
'@ghia/native': patch
---

Dragging a virtual list's scrollbar thumb or clicking its track reports `onVisibleRange` as a wheel does (the DOM fires `scroll` for it), and `scrollTo` or `scrollTop` that rests a bottom-aligned list at its end reports the rows it shows, not `[count, count + 1]`.
