---
'@ghia/native': patch
---

A commit whose layout and structure changes all lie inside a scroller (an overflow `auto` or `scroll` element that holds nothing else the retention excludes) is drawn as a patch of that scroller when its content has no roots of its own: the scroller is built and laid out again and gpui accepts the patch when nothing outside it moved (`getPatchCounters().relayoutPatches`), where it was a frame built whole. A change outside every scroller is counted as `unpatchable.Structure`, a patch whose box would leak out as `declines.NotContained`. A read of boxes or scroll metrics between the commit and the draw still lays the page out as before. Needs the contained relayout patch of the zed submodule, which a window opts in to.
