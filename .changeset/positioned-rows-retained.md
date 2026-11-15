---
"@ghia/native": patch
---

Absolutely positioned rows (the shape TanStack Virtual renders) are kept and moved between frames instead of rebuilt: a box its positioned parent places is no longer an escape for retention, a lifted row that forms its own stacking context moves with its scroller, and inserting a row before others no longer rebuilds them.
