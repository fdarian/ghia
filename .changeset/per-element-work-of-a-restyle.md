---
'@ghia/native': patch
---

The per-element work of a patch is cheaper: a restyle that only paints is judged once for the pair of interned styles it goes between (the border shorthands and the pointer-state refinements were parsed and folded again on every `setStyle`), the scan for patch roots asks the style of each element once, and a patch compares the tape it captured with the recording by what the writes hold, where it compared strings made by `format!` and `Debug`. The zed gitlink brings the shape store's cache of a text's width-independent marks, and `getLayoutCounters()` reads `snapComputations`, `snapCacheHits` and `endReshapeComputations`. On ghia-bench's mailbox the navigate proxy's App median is 32.0M instructions a key (33.4M with the snap cache alone, 36.5M before), and a hover crossing a row costs 3.66M (4.60M).
