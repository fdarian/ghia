---
'@ghia/native': patch
---

A list scroll measures the rows of the overdraw that have no size before it is classified, and builds a row that stays but no longer fits where it was recorded in the translate, where either held the frame whole: the keys of ghia-bench's mailbox that scroll the list are one patch and one translate (21 of 22 composed; the App median of keys 2 to 30 is 38.3M instructions, from 44.9M), and the scroll proxy's median is 5.56M (6.85M). `getPatchCounters().scrollPatch` has `rowsRebuilt`. A row built again is in the registries once (what it wrote before is taken out as the build starts, and the page forgets its records as it forgets a row that left), and a frame that kept no row in place settles the rows that left, where their boxes stayed. A patch of an anchor or a row, and the rows that left, no longer expand the replays a registry has not read to replace what they wrote (hover row crossings 4.70M, 4.62M).
