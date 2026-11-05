---
'@ghia/native': patch
---

A windowed `<virtual-list>` whose `itemCount` goes down keeps its list state: the heights measured so far, the scroll position and the focus handles stay, and only the rows at the tail are dropped, so the rows in view are no longer measured and laid out again on every change, and the work is as large as the drop and not as the count. A count that goes up still makes a new state, because gpui gives a spliced-in row no height hint (see `list_resize.rs`). A rebuild also skips a pass over every row that made no change.
