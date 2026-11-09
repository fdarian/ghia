---
'@ghia/native': patch
---

`createMutationQueue` walks a style for `blob:` URLs only when the style's JSON text contains `blob:`, instead of walking every style it sends.
