---
'@ghia/native': patch
---

`onVisibleRange` of a `<virtual-list>` fires when the visible range changes, not on every scroll event. A scroll that stays within the same rows (a 30 px wheel tick over 72 px rows) reported the same `startIndex` and `endIndex` again, a native-to-JS event and a handler call for nothing; the list now keeps the range it last reported and reports a different one. The first scroll still reports its range, and `scrollToItem` still reports its own.
