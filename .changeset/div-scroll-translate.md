---
"@ghia/native": patch
---

A wheel tick over a `div` scroller (`overflow: auto`) whose content is retained roots moves what the roots recorded and builds nothing, as a `<virtual-list>` wheel does; `getPatchCounters().scrollPatch` counts it, and a tick that cannot be a move (a culled child comes into reach, content no root holds, a list or scroller inside) is a whole frame with a `NotRelocatable.*` cause
