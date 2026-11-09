---
'@ghia/native': patch
---

The embedded run loop pump no longer calls `updateWindows` on every tick (AppKit updates the windows once per event itself) and re-arms its two run-loop watches in one `kevent` call: a pointer move costs 2.2% fewer instructions (0.594M to 0.581M).
