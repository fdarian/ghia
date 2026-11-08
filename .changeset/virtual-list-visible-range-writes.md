---
'@ghia/native': patch
---

`onVisibleRange` of a `<virtual-list>` fires when the scroll position is written, not only for a wheel. `scrollTo`, `scrollTop = n` and `scrollBy` (an app's keyboard navigation) moved the list without reporting the rows that came into view, so an app that moves a window of rows from `onVisibleRange` stopped following after its first window and the list went blank (after about 52 arrow keys in the mailbox example). A write now reports the range a wheel to the same position reports, once, and a write that leaves the list where it is reports nothing. `scrollToItem` reports the rows that show at the row it scrolls to, where it reported the item and the next.
