---
'@ghia/react': minor
---

A React app has the `window`, `document` and no-op `scrollTo` globals in the native build, because the renderer imports `@ghia/native/host`, and `@ghia/react` re-exports `isWebBuild` from it. The renderer tells the wasm build from the native one with `isWebBuild` instead of `typeof window`.
