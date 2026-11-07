# The web renderer and the Vite toolchain

The UI process of a Ghia app is a web renderer, like an Electron renderer or a React Native app: it has the globals a web page has, it resolves packages to their browser builds, and server code runs behind an RPC boundary. `ghia` (the `ghia()` plugin, `dev()` and `build()`, and the `ghia dev` / `ghia build` commands, a thin Effect CLI over them) and `@ghia/solid/vite` carry that into the toolchain. This file records why it is built this way; what an app author does is in [docs/solid.md](../solid.md) and [docs/reference.md](../reference.md#window-and-document).

The reason is the principle in [index.md](index.md#the-principle-dom-and-css-semantics): code written for the web works unchanged. The libraries a web developer reaches for (TanStack Query and Router, `nanoid`, `solid-js/web`) pick their build from `window` and from package export conditions, and a UI process that looks like a Node server gets their server builds.

## The renderer behaves like a page

- **`window === globalThis`.** In a page `window` is the global object, and in React Native the global is aliased the same way. Anything that stores state on `window` or compares to it works. The native build sets `globalThis.window = globalThis` and `globalThis.document` to Ghia's `document`.
- **Listeners go to two targets.** `globalThis.addEventListener` and `removeEventListener` register with Ghia's window target (`packages/native/js/events/window-target.ts`) and with Bun's original methods. Ghia's target is what turns the native event types on and dispatches `keydown`, pointer and focus events. Bun's keeps its own `error`, `unhandledrejection` and `message` events working. Each target dispatches only its own types, so no listener runs twice. `dispatchEvent` stays Bun's.
- **`scrollTo`, `scroll` and `scrollBy` do nothing.** Ghia has no document scrolling element, so the viewport cannot scroll, which is the DOM behaviour of a page that does not overflow. TanStack Router calls `scrollTo` on every navigation.
- **Nothing else is installed.** No `location`, `localStorage` or `innerWidth`. A missing API throws, which is the loud failure we want; a stub would hide the gap from the app that depends on it.
- **The browser (wasm) build installs nothing,** because it runs in a real page. `isWebBuild` from `@ghia/native/host` tells the two builds apart; `typeof window` can not, since the native build now has a `window` too.
- **Where it is installed.** `packages/native/js/dom-globals.ts`, exported as `@ghia/native/dom-globals`, is idempotent. `host.ts` imports it, so every Ghia UI has the globals, and the Vite plugin makes it the first import of the app entry, so a library that reads `typeof window` while it loads sees them.

## Vite, not Bun flags

Bun has no way to resolve packages like a browser. Measured in the renderer spike:

- **Bun always matches the `bun` and `node` export conditions.** `--conditions` only adds conditions, so the first matching key in a package's `exports` still wins, and a package that lists `node` before `browser` loads its server build.
- **`--conditions=browser` selects `@ghia/native`'s wasm build,** because its `exports` has a `browser` entry. The addon is unusable under the flag.
- **The flag is process-wide.** A Worker inherits it and cannot opt out, so it can not give the UI browser builds and server code Node builds in one process.
- **A runtime plugin cannot do it.** In Bun 1.4.4 `onResolve` is never called for bare specifiers. The `onLoad` swap that Ghia's preload used is a per-file allowlist (each package with a server/browser split needs an entry) and applies to the whole thread.
- **`Bun.build({ target: "browser" })` works for a bundle but gives no dev loop,** no HMR and no way to run the app from source.

Vite gives each environment its own resolution. `ghia()` defines a `ghia` environment with `consumer: "server"` and `createRunnableDevEnvironment`, so a Vite ModuleRunner imports the app inside Bun's own process. The conditions are `browser`, `import`, `module` and `default`. `consumer: "client"` does not work in a runner: it injects the browser HMR client (a WebSocket that fails), and gives no dependency externalization. Libraries that ship JSX source (`@tanstack/solid-router`) are compiled with Ghia's options too, through vite-plugin-solid's `solid` condition, which the preload could not do for `node_modules`.

What it costs, from the Vite spike (headless, Bun 1.4.4): a warm start to the first render was about 580 ms against about 207 ms for the preload, and an HMR update about 76 ms (bimodal, 20 or 120 ms) against about 92 ms for `bun --hot`.

## Only the addon stays external

Everything else is bundled (`noExternal: true`): `@ghia/solid`, `solid-js`, `@ghia/native/host` and the rest of the native package's JavaScript. Two copies of Solid break reactivity: a bundle that left `@ghia/solid` outside got its own client `solid-js` while `@ghia/solid` loaded another, and signals set in app code were never tracked by the renderer. So the app and the adapter share one `solid-js`, and `solid-js` is deduped.

Only `@ghia/native` is external, with its subpaths (`external` is a prefix match). The addon has to load as a real module, and externalizing the package keeps its `browser` export, the wasm build, from being picked. Consequences: there is one native instance, `dist/main.js` resolves `@ghia/native` from `node_modules` at run time, and an app lists `@ghia/native` as a direct dependency because the injected `dom-globals` import resolves from the app.

`solid()` adds solid-refresh itself, for `ghia dev` and for files outside `node_modules`. vite-plugin-solid treats a `server` consumer as SSR and does not add it, and an edit would reload the whole app. `solid()` also skips the `server` environment below, which has no renderer.

## Server code runs in a Worker

The UI thread draws frames, so server work that blocks it stalls the window. The decision is a Bun Worker behind an RPC boundary, with a separate process as the option for crash isolation. The numbers are in [docs/solid.md](../solid.md#why-a-worker): a Worker starts in 7 ms and adds 8 MB inside the UI process, a separate process starts in 24 ms and holds 22 MB idle, and a 500 ms server task stalls an in-process call for 499 ms and the UI by 0.3 ms from a Worker. A Worker shares the UI's address space, so a native crash takes the window with it; that is the price, and the process is the way out.

- **Ghia owns the Worker and the port, not the RPC library.** `serve(port: MessagePort): () => void` is the whole contract: wire a handler to the port, return what detaches it. oRPC's MessagePort adapter is the documented template and nothing in Ghia imports it. oRPC's `upgrade()` returns nothing and never removes its listeners, so the template passes it a port wrapper whose listeners hang on an `AbortController`.
- **The server is a second Vite environment,** `server`, with Vite's server defaults: Bun/Node resolution, `node_modules` external, no browser conditions and no `dom-globals`. The Worker runs its own ModuleRunner, whose transport is the Worker's message channel (as Cloudflare's workerd runner does), so the server graph resolves with its own conditions.
- **A server edit reloads the server on the same port.** The Worker calls the previous cleanup, clears the runner's cache, imports the entry again and calls `serve(port)` with the same port. Restarting the Worker would have needed a new port and a new client in the UI. A call in flight at that moment can go unanswered, which is acceptable in dev.
- **The UI's end of the port reaches the UI through a slot on `globalThis`** that `virtual:ghia/server` reads before the UI entry loads (dev), or through a `MessageChannel` and `new Worker(new URL("./server.js", import.meta.url))` in the virtual module (build).
- **`ghia build` compiles by default**, through `Bun.build` (`compile: { outfile }`, `format: "esm"`, `bytecode`, `minify`) with `dist/main.js` and, when there is one, `dist/server.js` as entrypoints. The Worker has to be an entrypoint, or the binary fails with `ModuleNotFound /$bunfs/root/server.js`. A plugin deletes `const require = createRequire(import.meta.url)` from `@ghia/native/index.js` (matched by the pnpm path and by `packages/native/index.js`), because Bun's bundler embeds an addon only for a free `require("./x.node")`; it throws when the line is gone, since that means the napi-rs loader changed shape. `ghia build --no-compile` and `build({ compile: false })` skip the compile. `Bun.build` is used because the CLI's `bun build --compile` takes no plugins. The binary is about 128 MB, 38 MB of it the addon.
- **The built `virtual:ghia/server` listens for the Worker's `error` event** and reports it, so a server that fails to start ends the app instead of leaving the UI waiting on a port nobody answers.

## Not decided

- `@ghia/react` stays on `bun --hot`. A `@ghia/react/vite` with Fast Refresh is the follow-up; the globals already apply to React through `host.ts`.
- Editing `vite.config` in `ghia dev`, and a UI full reload that re-runs the entry on the same `serverPort`, leaving the old run's listeners on it.

## Measured, and where

Both spikes ran on 2026-11-06 on one Mac, headless (the test renderer or plain Bun, never a live window), so no frame-time effect of the Worker is known. Each has a `FINDINGS.md` with the method:

- Renderer spike, `~/spaces/scratchs/ghia-renderer-spike/FINDINGS.md` (Bun 1.4.4, oRPC 1.16.2, TanStack Router 1.170 and Query 5.106): export conditions under Bun, the global `window`, and the transport comparison (median of five runs; a plain Bun process stood in for the UI, sequential calls only).
- Vite spike, `~/spaces/scratchs/ghia-vite-spike/FINDINGS.md` (Vite 8.3.6, vite-plugin-solid 2.11.15): the `ghia` environment, solid-refresh, the build, and the start and HMR timings above.

The behaviour is pinned by `packages/ghia/src/__tests__` (the CLI, spawning `ghia dev` and `ghia build`, with and without a server, and `dev()` and `build()` called in process), `packages/solid/src/__tests__/vite.test.ts` and `consumer.test.ts` (an app installed from tarballs with pnpm).
