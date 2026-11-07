---
'@ghia/solid': minor
---

The Bun preload and `@ghia/solid/bun-plugin` are removed, along with the compile cache and the Babel dependencies they used: run Solid apps with `ghia dev` and `ghia build` from `ghia`. `solid()` from `@ghia/solid/vite` compiles JSX for the universal renderer (`moduleName: "@ghia/solid"`) with Solid HMR in `ghia dev`, so an edited component updates without a reload, and it also compiles under vitest. `@ghia/solid` re-exports `isWebBuild`. Apps need `@ghia/native` as a direct dependency. In `ghia dev`, a full reload no longer logs `You appear to have multiple instances of Solid`: `solid()` resets the flag at the start of each run, and a real second copy of `solid-js` inside one run still warns. `render()` reports native errors to the `onUncaughtError` of its latest call instead of the first one's.
