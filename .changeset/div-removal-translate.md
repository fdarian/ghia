---
"@ghia/native": patch
---

Scroll perf: a wheel step over a `div` scroller whose commit only takes absolutely positioned children out of it (the rows a virtualizer stops rendering) is drawn as a translate that also takes those rows out of the frame, instead of a frame built whole. Rows that come in, rows in the flow, and a commit that changes anything else are drawn whole as before
