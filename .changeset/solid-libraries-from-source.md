---
"@ghia/solid": minor
---

`solid()` compiles Solid component libraries from their JSX source (the `solid` export condition, as Kobalte publishes it), so they run unmodified. `solid-js/web` resolves to the new `@ghia/solid/web`, which has `Dynamic`, `createDynamic`, `Portal`, `isServer` and the universal helpers on Ghia's renderer, and `@ghia/solid` resolves from inside `node_modules`, including a pnpm store. A module that imports a DOM-compiler helper from `solid-js/web` (`template`, `delegateEvents`, ...) because the library ships only code compiled for Solid's DOM renderer fails the build with an error naming the module and the imports.

`isDev` from `solid-js/web` follows the `solid-js` build that is loaded (`true` for its dev build, which vitest resolves through the `development` condition) instead of always being `false`.

`render` and `spread` from `@ghia/solid/web` follow `solid-js/web`: `render(code, element)` mounts into the element and returns a dispose (it no longer opens a window; that stays `render` of `@ghia/solid`), and `spread(node, props, isSVG, skipChildren)` takes `solid-js/web`'s arguments. `Portal` mounts in a render effect as `solid-js/web`'s does, so its content is in place before a sibling's `onMount`.
