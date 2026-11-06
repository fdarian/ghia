---
'@ghia/native': patch
---

The scene sorts its sprites by draw order and atlas texture, stably, and moves each primitive once instead of sorting the primitives themselves: a frame of 2000 glyphs spent a sixth of a rebuild in that sort. Sprites of one order never overlap, so which is drawn first is not seen, and the renderer batches by texture as before. Owner-approved engine change (docs/fork/syncing-upstream.md).
