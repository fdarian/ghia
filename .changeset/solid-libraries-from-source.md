---
"@ghia/solid": minor
---

`solid()` compiles Solid component libraries from their JSX source (the `solid` export condition, as Kobalte publishes it), so they run unmodified. `solid-js/web` resolves to the new `@ghia/solid/web`, which has `Dynamic`, `createDynamic`, `Portal`, `isServer` and the universal helpers on Ghia's renderer, and `@ghia/solid` resolves from inside `node_modules`, including a pnpm store. A module that imports a DOM-compiler helper from `solid-js/web` (`template`, `delegateEvents`, ...) because the library ships only code compiled for Solid's DOM renderer fails the build with an error naming the module and the imports.
