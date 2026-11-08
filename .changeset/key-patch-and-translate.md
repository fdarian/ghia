---
'@ghia/native': patch
---

A commit that restyles rows and swaps the content of a scroller, a read of layout after it and a programmatic scroll of a `<virtual-list>` (`scrollTo`, `scrollTop = n`) are one draw: the patch the read prepared is finished, the restyled rows are patched where they stand, and the rows are moved by a translate that builds the row that comes in, where the draw was a frame built whole. A write to a list's offset notifies no view, so it no longer discards the patch a read prepared; a frame whose translate declines is built whole at the new offset, as before. A restyled row of a virtual list that the frame shown does not hold needs no patch (a scroll that brings it in builds it with its new style), so a commit that restyles one is no longer `Commit` at the read. `getPatchCounters().scrollPatch.composed` counts the translates that came after a patch in the same draw. Needs the patch-and-translate draw of the zed submodule.
