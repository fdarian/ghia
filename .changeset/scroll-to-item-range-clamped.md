---
'@ghia/native': patch
---

`scrollToItem` on a virtual list reports the rows the list shows after the scroll in `onVisibleRange`, as a wheel to that position reports them. A row near the end used to report the row and the next (`[last, last + 1]`) while the list showed the last viewport's worth of rows, and the native addon's `scrollToItem` reported nothing. The range is read from the paint of the frame that applies the scroll, after the layout has held the position to what the list can scroll to, so the event comes with that frame and not inside the call.
