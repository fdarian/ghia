---
'@ghia/native': patch
---

A commit whose layout and structure changes all lie inside a scroller (an overflow `auto` or `scroll` element that holds nothing else the retention excludes) is drawn as a patch of that scroller, whatever it holds (text, boxes with children, a keyed swap of the content with another number of elements; gpui splices the ranges of the scroller into the frame): the scroller is built and laid out again and gpui accepts the patch when nothing outside it moved (`getPatchCounters().relayoutPatches`, `rewrittenRecordings`), where it was a frame built whole. A change outside every scroller is counted as `unpatchable.Structure`, a patch whose box would leak out as `declines.NotContained`. A read of boxes or scroll metrics between the commit and the draw still lays the page out as before. Needs the contained relayout patch of the zed submodule, which a window opts in to.
