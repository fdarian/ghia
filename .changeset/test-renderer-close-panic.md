---
"@ghia/native": patch
---

`TestRenderer.dispose()` closes the window itself, while its app is alive, and no longer leaves that to a block on the main queue. A block still queued when the app was released ran in the next renderer's `dispose()` and aborted the process with "app was released before async operation completed".
