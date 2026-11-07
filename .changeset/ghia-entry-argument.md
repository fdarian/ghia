---
'ghia': minor
---

`ghia dev [entry]` and `ghia build [entry]` take the app entry as an optional argument, resolved against the Vite root, which replaces the `entry` option of `ghia()` (so one Vite config can serve several entry files). `dev()` and `build()` take it as the `entry` option, and it is the input of the `ghia` build.
