---
"@ghia/solid": minor
---

`solid()` compiles Solid component libraries from their JSX source (the `solid` export condition, as Kobalte publishes it), so they run unmodified. `solid-js/web` resolves to the new `@ghia/solid/web`, which has `Dynamic`, `createDynamic`, `Portal`, `isServer` and the universal helpers on Ghia's renderer, and `@ghia/solid` resolves from inside `node_modules`, including a pnpm store. A module that imports a DOM-compiler helper from `solid-js/web` (`template`, `setAttribute`, ...) because the library ships only code compiled for Solid's DOM renderer fails the build with an error naming the module and the imports.

`isDev` from `solid-js/web` follows the `solid-js` build that is loaded (`true` for its dev build, which vitest resolves through the `development` condition) instead of always being `false`.

`render` and `spread` from `@ghia/solid/web` follow `solid-js/web`: `render(code, element)` mounts into the element and returns a dispose (it no longer opens a window; that stays `render` of `@ghia/solid`), and `spread(node, props, isSVG, skipChildren)` takes `solid-js/web`'s arguments. `Portal` mounts in a render effect as `solid-js/web`'s does, so its content is in place before a sibling's `onMount`.

`@ghia/solid/web` also exports the server-only API of `solid-js/web`'s browser build, so `@solidjs/router` and `@solidjs/meta` compile from their JSX source (the router still needs `window.history`, and `Title` a `<title>` element, which Ghia has not): `getRequestEvent` (`undefined`), `NoHydration`, `Hydration`, `getHydrationKey`, `useAssets`, `ssr*`, `renderToString*` and the rest, with the browser build's behaviour; `delegateEvents` and `clearDelegatedEvents` do nothing (Ghia's compiled JSX has no delegated handlers) and `hydrate` throws. The build error for a name that is still missing (`template`, `setAttribute`, ...) says those need Solid's DOM renderer and no longer claims the whole library is DOM-compiled. Only JavaScript and TypeScript modules are checked for those imports, so a JSON or CSS module that mentions `solid-js/web` no longer fails the build.
