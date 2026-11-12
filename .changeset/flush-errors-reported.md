---
"@ghia/solid": patch
"@ghia/react": patch
"@ghia/native": patch
---

A throw while a frame's changes are flushed no longer stops the later flushes. Releasing removed nodes and sending the batch are guarded apart, so a throw in the first never skips the second, and Solid's `finishRemovals` and React's `releaseDetachedNodes` release every node and then rethrow, as one error or an `AggregateError`. A Solid root without `onUncaughtError` now reports the errors of a scheduled flush, and native errors, with `console.error`, as React already did; `root.render()`, `flush()`, `flushSync()` and `unmount()` rethrow to the caller after the teardown finished. `@ghia/native/host` exports `runAll`, the helper both adapters use.
