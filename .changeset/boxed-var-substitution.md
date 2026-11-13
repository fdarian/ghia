---
"@ghia/native": patch
---

Building an element no longer moves a whole style (about 13 KB) through the `var()` substitution step when the element has no `var()`, which is nearly every element in every frame. Scrolling a long list costs about 1% fewer instructions.
