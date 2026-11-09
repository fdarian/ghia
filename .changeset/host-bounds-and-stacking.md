---
'@ghia/native': patch
---

The bounds of a host element are read by one shared layout probe instead of two boxed listeners, the bounds registry updates a box where it is stored, and a stacking context moves each lifted entry once. A column of 50 rows built whole costs 2.7% fewer instructions (942.2k to 916.7k a row), and `onLayout`, `getBoundingClientRect` and the observers read the same numbers.
