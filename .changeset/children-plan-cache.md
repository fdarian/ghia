---
'@ghia/native': patch
---

The children plan of a host element (its paragraphs and blocks, and the text a `<text>` reads out) is kept on the element and found again while its subtree, the `white-space` it inherits and the `display` and `order` its `@container` blocks gave are unchanged, instead of planned in every build: 50 rows built whole cost about 55k fewer instructions a row (a column 45.07M to 42.31M a frame, a list 60.79M to 58.05M). The switch is the style cache's (`setStyleCache`, `GPUIX_STYLE_CACHE_OFF`, and `GPUIX_RETAIN_VERIFY` plans again for every kept plan and asserts the two equal); `getBuildCounters()` has `plansKept` and `plansComputed`.
