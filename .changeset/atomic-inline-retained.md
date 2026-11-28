---
"@ghia/native": patch
---

An element with an atomic inline in its paragraph (a default `<button>` in a block, an `inline-block`, `inline-flex`, `inline-grid` or `inline-table` box) is recorded, replayed, moved by a scroll and patched like one with none: the box used to keep every element around it from being a retained root, so a row with a button was built by every frame and a list of such rows could not be moved by a wheel. A wheel over 60 rows with a `<button>` each builds at most 8 elements and a hover at most 24, where each was a frame of 248. `setRetainLift` no longer takes `atomic-inline`. A patch root that a late build skipped inside a patch root is no patch root (the verifier found a hover patch of one it could not compare).
