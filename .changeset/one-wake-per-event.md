---
'@ghia/native': patch
---

Input wakes JS once per event on macOS 26 and later. AppKit begins a Core Animation transaction for every event it sends, and its update cycle committed one that began before the display's next frame boundary from a timer at that boundary, which woke JS for a tick that did nothing else. The pump now commits it right after the event. Mouse moves over ghia-bench's Mailbox at 120 Hz: 1.03 to 1.09 wakes per move against 1.46 to 1.88, about 140 process wakeups a second against 185 to 230, and 4 to 12% fewer instructions per move.
