---
'@ghia/solid': minor
---

The Bun preload and `@ghia/solid/bun-plugin` are removed, along with the compile cache and the Babel dependencies they used: run Solid apps with `ghia dev` and `ghia build` from `@ghia/vite`. `solid()` from `@ghia/solid/vite` compiles JSX for the universal renderer (`moduleName: "@ghia/solid"`) with Solid HMR in `ghia dev`, so an edited component updates without a reload, and it also compiles under vitest. `@ghia/solid` re-exports `isWebBuild`. Apps need `@ghia/native` as a direct dependency.
