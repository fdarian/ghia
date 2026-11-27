---
"@ghia/native": patch
---

A hover (or a commit) that only paints is a patch frame when the element's `transition` can run on colours only (`background-color`, `color`, the border, outline and text-decoration colours): the patch starts the transition and each tick of the run is a patch frame too, where the hover was a frame built whole. A list with `all`, `opacity`, a transform or a size is still built whole
