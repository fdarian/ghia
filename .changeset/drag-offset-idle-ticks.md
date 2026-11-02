---
'@ghia/native': patch
---

A page with a `Reorder.Item` (a `layout` box with `dragOffset`) beside a looping animation patches the loop's ticks while nobody holds the item, as it does without the item. Until now every tick was drawn whole for as long as the item existed. While an item is held, its ticks are still whole frames.
