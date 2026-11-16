---
"@ghia/native": patch
---

A scroller that is no virtual list (TanStack Virtual's div scroller) records its rows for the travel of a row that is shown, three viewports of the scroller, as a list does, so a row is no longer built again while it is shown after a few 30 px wheel steps.
