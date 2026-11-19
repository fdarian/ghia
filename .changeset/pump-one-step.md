---
"@ghia/native": patch
---

A scroll no longer freezes while frames take longer than a vsync. The macOS pump ran display-link frame steps back to back in one tick for as long as the link had another one queued, so wheel events were not read and JS did not run for 0.1 to 2 s at a time, and the page kept presenting a frozen scroll. A tick now runs at most one frame step, and the next tick reads the events first.
