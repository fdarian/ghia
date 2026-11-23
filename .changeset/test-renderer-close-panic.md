---
"@ghia/native": patch
---

`TestRenderer.dispose()` closes the window itself, while its app is alive, and no longer leaves that to a block on the main queue. A block still queued when the app was released ran in the next renderer's `dispose()` and aborted the process with "app was released before async operation completed". `RowOracle.dispose()`, and a `RowOracle` that a newer one replaces, close their window the same way.

Two test-only methods: `TestRenderer.disposeLeavingMainQueueForTest()` (`dispose` without running the main queue, so the close block stays queued) and `runMainQueueToMarkerForTest()` (runs the main run loop until a block queued now on the main dispatch queue has run, so every block queued before it has; throws after 5 seconds).
