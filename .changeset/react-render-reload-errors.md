---
'@ghia/react': patch
---

After the entry is evaluated again, runtime errors from the native renderer, the frame loop and the process handlers are reported by the latest `render()` call's module, so the error overlay no longer mounts through the first run's copy of the reconciler.
