# Compiling an app to native

Could a Ghia app ship as native code, with no JavaScript engine in it? This records what was tried, so the question can start from the last result. The only compiler tried so far is [scriptc](https://github.com/vercel-labs/scriptc) from Vercel Labs.

**Result on 2026-11-01: no.** scriptc 0.4.7 cannot build a Ghia app or the frameworks under it, and its one Solid binary that built printed the wrong tree without warning. Tested at `5bb1295b`, on macOS arm64.

## What was measured

| Target | Coverage | Build | Runs like Bun |
|---|---|---|---|
| `zod` 4.6.7 and `eventsource-parser` 4.1.3 | 4745/4752 (99%) | Yes, 8.2 MB | Yes, on a small entry |
| `solid-js` 1.9.15, browser build | 1060/1065 (99%) | No: compiler crash | Not run |
| `react-reconciler` 0.33.0 with `react` 19.3.1 | 5054/5369 (94%) | No | Not run |
| `packages/native/js` and `packages/solid/src` | None: it stops at type checking | Not run | Not run |
| Solid smoke test on a fake host, browser build | 1129/1133 (99%) | No: same crash | Not run |
| Solid smoke test on a fake host, server build | 477/477 (100%) | Yes, 0.9 MB | **No: wrong tree** |

Coverage overstates what works: every row that failed to build or run correctly scored 94% or more.

## Blockers

**Solid crashes the compiler.** Solid's browser build fails with an internal error on its own source, `const [transPending, setTransPending] = createSignal(false)` at `solid-js/dist/solid.js:559`:

```
SC9001: internal compiler error: TDZ global "transPending" must have record, function, or checked-value storage — please report this
```

A top-level `createSignal` in app code hits the same error on either build.

**Solid resolves to the wrong build.** scriptc uses Node's resolution, so `solid-js` means `dist/server.js`, where effects don't run. Ghia's Bun plugin redirects it to `solid.js`, and any test has to do the same. The 100% row above is the server build, so it says nothing about reactivity.

**Object identity is lost through generics.** In the server-build binary, host nodes returned from `createElement` and passed back through Solid's generic `T` came back as copies, so `insertNode` changed a copy and children disappeared. An `indexOf` identity probe showed this, and scriptc gave no divergence warning:

```
Bun:    <root><box data-count=0><label>"count=0"</label><kind><even></even></kind></box></root>
Native: <root><box data-count=0></box></root>
```

This is the most serious result, because a universal renderer depends on host node identity. Passing the compile step isn't enough: compare the output against Bun.

**React doesn't build.** The one build error is calling the default import, `Reconciler({...})`, which [reconciler.ts:3](../packages/react/src/reconciler/reconciler.ts:3) also relies on:

```
SC1090: module namespace objects as values (access 'Reconciler' members directly) are not supported yet
```

Behind it, coverage defers these to runtime: 217 uses of a `var` above its declaration, 65 assignments to non-variables, 11 `Reflect.*` calls used as values, `Reflect.construct`, and `new MessageChannel`.

**Ghia's runtime doesn't type-check.** scriptc checks against ES2025 and Node types and ignores the project's `lib`, so 14 errors about DOM globals stop it before any analysis: `window`, `document`, `reportError`, `KeyboardEvent`, `EventInit`. Past those, its docs list more problems for this code: `WeakRef` is unsupported ([bounds.ts](../packages/native/js/bounds.ts), [keyframes.ts](../packages/native/js/keyframes.ts), [web-animations.ts](../packages/native/js/web-animations.ts)), `FinalizationRegistry` callbacks never run, and `Reflect` has no documented support. None of this was measured.

**The addon can't load.** scriptc rejects `.node` files at compile time, and Node-API is the whole boundary to the renderer. Replacing it means a C ABI and a Rust `staticlib`, within FFI limits that exclude structs by value, owned pointer returns and `dlopen`. This was read from scriptc's docs, not tried. Every run above used a stub in place of the addon.

## What wasn't measured

- The frame loop. It's tuned to Bun's event loop ([frames-and-wakes.md](fork/frames-and-wakes.md)). `tick()` doesn't block, so scriptc's lack of `CFRunLoop` support may not matter, but no real window has run.
- Frame time, memory, Base UI and FF.
- The Solid browser build at runtime, since it never built.

## The trade-off

Even a working compiler narrows what Ghia offers. Today any npm package runs. Under scriptc, a package has to compile, and may need type patches or change behaviour, as the smoke test did. That conflicts with being compatible with the TypeScript ecosystem, so compiling to native suits an app with a fixed set of dependencies better than the framework's default.

To ship a smaller app today, see "Ship a binary" in [reference.md](reference.md) and [hermes/README.md](../hermes/README.md). Hermes still ships an engine.

## Checking again

Run these in order and stop at the first failure. Each needs a new scratch directory outside the repo, with `"type": "module"` in its `package.json`, and the versions from `pnpm-lock.yaml`.

1. **Solid.** Replace `node_modules/solid-js/dist/server.js` with `solid.js`, as Ghia's Bun plugin does, then build an entry that imports `createSignal`, `createEffect`, `createRoot` and `createRenderer`. The crash above should be gone.

   ```bash
   scriptc build entry.ts -o entry
   ```

2. **Identity.** Write a `solid-js/universal` renderer over an in-memory fake host, update a signal a few times and print the tree each time. Run it under Bun and as a binary, then diff the two. This is the check that decides the question.
3. **React.** `scheduler` has to be named, because it ships no declarations.

   ```bash
   scriptc coverage entry.ts "--npm-static=react-reconciler...,scheduler"
   ```

4. **Ghia's runtime.** Copy `packages/native/js` and `packages/solid/src` without their tests, `bun-plugin.ts` or `preload.ts`, and stub the addon from `packages/native/index.d.ts`. Getting past the type errors needs DOM type declarations, which this run didn't add.

If 1 to 3 pass, the addon boundary and the frame loop are the real work, and they are worth a design then.
