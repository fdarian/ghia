---
'@ghia/native': patch
---

A `<nativeview>` under an ancestor with `opacity`, `filter`, `mask` or `clip-path` now fades with the ancestor and keeps its children above it: the ancestor's effect group is split at the view, so the box is composited below the view and the children above it. The view takes the product of the opacities of the groups around it, a filter group's included.
