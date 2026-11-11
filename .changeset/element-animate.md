---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`element.animate(keyframes, options)` as in the Web Animations API, so `@dnd-kit/dom` runs unchanged: keyframes as an array of objects or one object of arrays (`{ translate: [from, to] }`), a duration or `delay`, `endDelay`, `duration`, `iterations`, `iterationStart`, `direction`, `fill`, `easing` and `id`. It returns the same `Animation` `getAnimations()` lists, with `pause()`, `finish()`, `cancel()`, `finished` and the rest, sampled by the engine of CSS animations and playing above them. `composite: "add"` and `"accumulate"`, `commitStyles()` and `persist()` are not built.
