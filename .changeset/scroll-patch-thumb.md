---
'@ghia/native': patch
---

The frame drawn after a wheel event over a `<virtual-list>` with the scrollbar the system draws is no longer built either: the translate moves the thumb with the rows (the list's bar tells gpui, through `Window::paint_scroll_thumb`, how a scroll moves its thumb, and the quad is written over the operation it painted, at the bounds the build would paint it at), and starts the second of the bar's hold again as a built frame does. Where the thumb cannot be put there, the frame is drawn whole and says why: `Thumb.size`, `Thumb.alpha`, `Thumb.appear` (the first wheel after the bar faded) and `Thumb.track` in `getPatchCounters().scrollPatch.held`, and `applyDeclines.Thumb`. A frame that moves the rows is also drawn whole when the bar of a scroll container is due a frame (the end of its hold). The mailbox proxy with its default scrollbar patches 328 of 720 frames, as with `scrollbarWidth: "none"`, where it patched none.
