---
'@ghia/native': patch
---

The thumb of the scrollbar of a `<virtual-list>` is moved back by a translate that returns the rows to where the last whole frame painted it: the translate compared the new place of the thumb with the whole frame's and left a thumb that an earlier translate had moved on its other pixel.
