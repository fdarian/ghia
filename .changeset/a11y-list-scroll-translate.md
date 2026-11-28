---
"@ghia/native": patch
---

macOS: a wheel tick over a `<virtual-list>` is a translate with a screen reader connected too (VoiceOver users drew every tick as a whole frame): the translate moves the bounds of the rows' accessibility nodes, takes the nodes of rows that leave out of the tree, puts those of rows that come in, and tells the platform of what changed; `getPatchCounters().scrollPatch.applyDeclines.A11y` counts a tree a translate cannot edit (a row that holds the focus or claims an author id leaves or comes in), and the test renderer's `getShownA11yTree()` reads the tree of the frame drawn last without the flush that draws a frame built whole over it
