---
"@ghia/solid": patch
---

`@ghia/solid/tsconfig` is a tsconfig base for apps (`"extends": "@ghia/solid/tsconfig"`): it sets `jsx: "preserve"` and `jsxImportSource: "@ghia/solid"` and maps `@ghia/solid/jsx-runtime` and `@ghia/solid/jsx-dev-runtime` to the app's `node_modules` with `${configDir}` (TypeScript 5.5 or newer). A Solid library that ships `.tsx` source and depends on `solid-js` only no longer fails with TS2875 under pnpm. An app with its own `paths` copies the two entries, since TypeScript replaces `paths` from a base.
