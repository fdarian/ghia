---
'@ghia/native': patch
---

An app serves the automation protocol on stdin only when `GPUIX_AUTOMATION=1` is set in its environment. It used to turn on whenever `process.stdin` was not a terminal, so an app started by a harness with a pipe or closed stdin (or from Finder) loaded zod and eventsource-parser and read stdin for nothing. `launch()` sets the variable in the child; a driver that spawns the app itself and speaks the protocol must set it too, and there is no fallback to the terminal check.
