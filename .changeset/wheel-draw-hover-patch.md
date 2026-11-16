---
"@ghia/native": patch
---

A wheel event over a `<virtual-list>` whose draw meets the hover tick of the previous wheel is a patch and a translate in one draw, where it was a frame built whole. The wheel notifies the list's view, and a patch declined a draw with a view queued (`PendingView`), so the tick's hover patch was refused and the gate then saw its hover paint as an edit. A patch now goes through when the only queued view is the one the scrolled list named, and the translate follows it in the same draw; any other queued view still declines. The test renderer takes `setHoverResyncByFrame(false)` to resync the hover from the draw that moved the rows, as a window does. Rows that a frame built whole replayed (`Hover:Relocated`) are still a frame built whole.
