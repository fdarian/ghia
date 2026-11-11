---
"@ghia/native": patch
---

A layout edit is patched at the fixed-size box that holds it instead of drawing the whole frame: a text edit in a header or in a row of a 10,000-row list costs about as much as a hover (frame instructions 235M -> 1.4M and 323M -> 1.7M), including rows a wheel has scrolled. A row whose answers to its parent are unchanged no longer re-runs the parent's flex, block or grid pass. Set `GPUIX_BOX_ROOTS_OFF=1` to turn box roots off.
