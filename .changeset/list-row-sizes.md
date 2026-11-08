---
'@ghia/native': patch
---

A `<virtual-list>` tells its list the size of a row whose root style fixes it (a `div` with a `height` in px and a width that is in px or fills a block, padding, margins and borders in px, no min or max size, aspect ratio, container block, motion or transition of a size, and states that only paint), so the rows it does not show are no longer built and laid out in a scratch frame to be measured, and a row that comes into the overdraw of a scroll is built once, where it shows. The list checks every row that shows against what it was told (`getPatchCounters().scrollPatch.declarationMismatches`), and `rowsMeasuredByLayout` and `rowsMeasuredByDeclaration` count how the rows were measured. `GPUIX_LIST_SIZES_OFF=1` turns it off for a measurement. `getPatchCounters().deferredSceneRebuilds` counts the patches that left the scene to the translate after them. Needs the zed submodule at `8434d5c7ad`.
