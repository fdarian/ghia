---
"@ghia/solid": patch
"@ghia/react": patch
---

A throw while a frame's changes are flushed no longer stops the later flushes. Releasing removed nodes and sending the batch are guarded apart, so a throw in the first never skips the second, and `finishRemovals` (Solid) and `releaseDetachedNodes` (React) release every node and then rethrow, as one error or an `AggregateError`. A Solid root without `onUncaughtError` now reports these errors, and native errors, with `console.error`, as React already did.
