---
'@ghia/native': patch
---

The scene kept for the next relocatable subtree (a row of a `<virtual-list>`) is cleared once the row's recording has been taken from it: it held the primitives of the last row, their path vertices and the pixel buffers of surfaces among them, alive until the next relocation.
