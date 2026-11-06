---
'@ghia/solid': patch
---

The Solid preload and `@ghia/solid/bun-plugin` now send `solid-js/web` to Solid's client build (`web.js`), as they already did for `solid-js` and `solid-js/store`. Bun resolved it through the `node` export condition to `web/dist/server.js`, so `isServer` from `solid-js/web` was `true` in a Ghia app and libraries that branch on it ran their server code: `@tanstack/solid-query` ignored `retry`, forced `throwOnError` on and returned `undefined` for `refetch`. `isServer` is now `false`, and the retries and `refetch` work. `@tanstack/query-core` has its own `typeof window` check, which a Ghia app (no global `window`) still fails: call `environmentManager.setIsServer(() => false)` once at startup (see the `window` and `document` section of the reference docs).
