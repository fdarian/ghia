---
'@ghia/native': patch
---

A hover after a wheel scroll is a patch frame again, and a step of a list's scrollbar fade is a repaint of the thumb, not a frame built whole. A row that a hover patched during a wheel left an id in the retention bookkeeping that no longer existed and every later hover was declined; on ghia-bench's mailbox the hover after a scroll goes from 0 of 480 ticks patched (crossing median 7.8M) to 18 of 480 (3.5M), and 243.7M to about 120M for the phase. A prepared patch no longer adds a start region for each element of each patched row, so a long run of hovers leaves the registries the size they were.
