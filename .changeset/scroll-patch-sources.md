---
'@ghia/native': patch
---

The frame drawn after a wheel event over a `<virtual-list>` is built whole when a source other than the scroll differs from the frame shown (a press that restyles with `:active`, the focus, a selection, a measurement, a link, a command, a custom element): they notify the view with the entity the list notifies with, so the tree and the queue of views could not tell them apart and the translate left them out of the picture until the next frame built whole. The gate compares the sources as a tick does and says `Edited` (`getPatchCounters().scrollPatch.reasons`).
