---
"@ghia/native": patch
---

A hover that follows a scroll, and a wheel that meets one, are patches where they were frames built whole.

- A wheel event over a `<virtual-list>` whose draw meets the hover tick of the previous wheel is a patch and a translate in one draw. The wheel notifies the list's view, and a patch declined a draw with a view queued (`PendingView`), so the tick's hover patch was refused and the gate then saw its hover paint as an edit. A patch now goes through when the only queued view is the one the scrolled list named, and the translate follows it in the same draw; any other queued view still declines. The test renderer takes `setHoverResyncByFrame(false)` to resync the hover from the draw that moved the rows, as a window does.
- A hover that follows a scroll is a patch when the row it leaves is one the scroll took out of the frame. The hover follows late (when the scroll ends or a build changed the page), so the previous hover is usually a row of a `<virtual-list>` that the frame shown no longer holds; the patch declined it as `Hover`.
- A row of a `<virtual-list>` that a frame built whole replayed at a moved place is patched too (it was `Hover:Relocated` until something built the row again), and so is a row that holds an `overflow: hidden` box, such as an ellipsized line of text. A box only code scrolls (`scrollTop`) has an offset and an extent relative to its padding box, which moves with the row, and the bounds its scroll handle reports move with the recording. Only a row with a box the user scrolls, or one that has a non-zero offset, still declines.
- A row that comes in under a still pointer is a translate; it was declined as `Pointer` (`applyDeclines.Pointer` is gone), because a scroll no longer moves the hover under a pointer that stays.
