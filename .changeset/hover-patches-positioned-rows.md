---
"@ghia/native": patch
---

A hover that crosses the rows of a TanStack Virtual list (`position: absolute` with a `transform`, a `:hover` background and an absolutely positioned box of their own) is a patched frame, as it was for the rows of `<virtual-list>`: 3.2M instructions a crossing, not 8.9M. A root that lifts itself and forms its own stacking context is a hover patch root; one that something lifts out of, into the context around it, still is not.
