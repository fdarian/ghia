---
"@ghia/native": patch
---

A scroll of a list copies the pixels that stay and draws only what scrolled in, instead of drawing the whole list again: a wheel translate presents the list's pixels moved by the scroll plus the strip of rows that came in and the scrollbar's thumb, and each part of the frame draws only the primitives that meet it (a translate frame of a mailbox-shaped scene: 0.38 ms of GPU time to 0.24; the scroll phase of the live mailbox -27%). The picture is the same as a whole draw. `getPatchCounters().scrollPatch` gains `shifted`, the frames presented with a shift, and `GPUI_GPU_TIMES` lines gain `shift=<dx>,<dy>|none rects=<n>`.
