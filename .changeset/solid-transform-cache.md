---
'@ghia/solid': patch
---

The Solid preload and `@ghia/solid/bun-plugin` cache each compiled JSX/TSX file in `~/Library/Caches/ghia/solid-transform/` (one entry per source path, invalidated by the source, the `@ghia/solid`, Babel and `babel-preset-solid` versions and the preset options). Babel is now imported only when a file misses, so a warm launch no longer loads it: 55-73 MB less memory per app (the demo 188 to about 130 MB, the fluid example 262 to about 195 MB).
