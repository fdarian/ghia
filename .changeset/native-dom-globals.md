---
'@ghia/native': minor
---

In the native build, `window` (the global object itself), `document` (Ghia's document) and no-op `scrollTo`, `scroll` and `scrollBy` are installed as globals by the new `@ghia/native/dom-globals`, which `@ghia/native/host` imports, so every Ghia UI has them; the wasm build runs in a real browser and installs nothing. `addEventListener` and `removeEventListener` on the global object register with both Ghia's window target and the runtime's, so `keydown`, pointer and focus events reach them while `error` and `unhandledrejection` keep working. `isWebBuild` is exported from `@ghia/native/host`: `true` in the wasm build, `false` in the native one. Use it instead of `typeof window`, which is now `"object"` in both. Web libraries such as TanStack Query and Router, whose client code reads `window` and calls `scrollTo`, now run it.
