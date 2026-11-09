# @ghia/react

## 0.12.1

### Patch Changes

- 9100adc: The mutation batch is one binary byte array instead of JSON text. `createMutationQueue` writes each op as it is enqueued through `WireWriter` (internal to `@ghia/native`, `js/wire.ts`; not exported) into reused buffers, with no tuple per op and no `JSON.stringify` of the batch, and `applyBatch(bytes: Uint8Array)` on the live, test and wasm renderers decodes it in place (`batch::wire`), so the napi call transcodes no string and the decoder allocates nothing per op beyond what it keeps. The format is specified in `docs/reference.md` ("Wire format"). **Breaking for anything that calls `applyBatch` itself**: it takes the bytes, not a JSON string; tests that built or parsed a batch use `encodeWireBatchForTest` and `decodeWireBatchForTest` from `@ghia/native/testing`. `MutationRenderer.setStyle` takes the style's JSON text as an optional third argument, which Solid passes from the text its write comparison already made, so a written style is stringified once. A failed batch is put back in front of what was enqueued since, and a style native rejects is cut out of the batch by its byte range, as before.
- Updated dependencies [9100adc]
- Updated dependencies [9100adc]
- Updated dependencies [a1ba92a]
- Updated dependencies [57bab8d]
- Updated dependencies [5bf8afb]
- Updated dependencies [14d6582]
- Updated dependencies [14d6582]
- Updated dependencies [4a139f0]
- Updated dependencies [381e84f]
- Updated dependencies [a5db856]
- Updated dependencies [6c9f646]
- Updated dependencies [a424e75]
- Updated dependencies [3b381be]
- Updated dependencies [14d6582]
- Updated dependencies [6719139]
- Updated dependencies [a0cfc02]
- Updated dependencies [14d6582]
- Updated dependencies [14d6582]
- Updated dependencies [9282468]
- Updated dependencies [14d6582]
- Updated dependencies [e1c7649]
- Updated dependencies [5a6650c]
- Updated dependencies [14d6582]
- Updated dependencies [14d6582]
- Updated dependencies [afade40]
  - @ghia/native@0.12.1
  - ghia@0.12.1

## 0.12.0

### Minor Changes

- 4c7d9c6: A React app has the `window`, `document` and no-op `scrollTo` globals in the native build, because the renderer imports `@ghia/native/host`, and `@ghia/react` re-exports `isWebBuild` from it. The renderer tells the wasm build from the native one with `isWebBuild` instead of `typeof window`.
- 9d68f3b: `@ghia/react/vite` exports `react()`: @vitejs/plugin-react's JSX transform with the automatic runtime and `jsxImportSource: "@ghia/react"`, and React Fast Refresh in `ghia dev`. An edit to a component module updates the tree in place and keeps the `useState` of the components around it, and the entry does not run again; any other edit re-runs the entry, and refresh still works after it. Use it next to `ghia()` in the Vite config, and run React apps with `ghia dev` and `ghia build` instead of `bun --hot`. `react({ include, exclude })` scopes it to some files, for an app that also uses `solid()`. `ghia` and `vite` are optional peer dependencies, as for `@ghia/solid`.

### Patch Changes

- 751f7e2: After the entry is evaluated again, runtime errors from the native renderer, the frame loop and the process handlers are reported by the latest `render()` call's module, so the error overlay no longer mounts through the first run's copy of the reconciler.
- Updated dependencies [8fcd806]
- Updated dependencies [7528529]
- Updated dependencies [8fe6300]
- Updated dependencies [9be6797]
- Updated dependencies [c936c56]
- Updated dependencies [d711914]
- Updated dependencies [521b773]
- Updated dependencies [9d68f3b]
- Updated dependencies [3a1421b]
- Updated dependencies [c4b1800]
- Updated dependencies [0a746f2]
- Updated dependencies [4ee7fa6]
- Updated dependencies [57e782f]
- Updated dependencies [c4e29c2]
- Updated dependencies [4c7d9c6]
- Updated dependencies [d246bac]
- Updated dependencies [7419c3b]
- Updated dependencies [134e72b]
- Updated dependencies [5a6ecc0]
- Updated dependencies [fe4feb4]
- Updated dependencies [05929b1]
- Updated dependencies [4944439]
- Updated dependencies [c0e1eb7]
- Updated dependencies [1ed2c72]
- Updated dependencies [fcc0d2e]
- Updated dependencies [cef50f9]
- Updated dependencies [b871632]
- Updated dependencies [c6a6271]
- Updated dependencies [4e79714]
- Updated dependencies [69e9c2b]
- Updated dependencies [671330d]
- Updated dependencies [3ed3d47]
- Updated dependencies [c642e6a]
- Updated dependencies [523e8dd]
- Updated dependencies [bd73d27]
- Updated dependencies [a0b62db]
- Updated dependencies [a198da5]
- Updated dependencies [863db25]
- Updated dependencies [ec13354]
- Updated dependencies [439271f]
- Updated dependencies [9bce77d]
- Updated dependencies [f6b9458]
- Updated dependencies [77be0bf]
- Updated dependencies [4b90976]
- Updated dependencies [c668d7f]
- Updated dependencies [8d9a70f]
- Updated dependencies [dec3bf7]
- Updated dependencies [a0d537f]
  - @ghia/native@0.12.0
  - ghia@0.12.0

## 0.11.1

### Patch Changes

- a2d57e7: A window opened with `GPUIX_BACKGROUND=1` in the environment emulates focus, as Chrome does with CDP's `Emulation.setFocusEmulationEnabled`: it behaves as active for `onFocus`, `onBlur`, `:focus-visible`, the caret and `focusElement`, without becoming the key window or activating the app. Until now a window opened behind other apps (`focus: false`) fired no focus event and drew no caret while typed text still arrived. A window without the variable is unchanged: a window that is not active fires no focus events, as in Chrome, and they fire once it is activated. The library reads the variable once, when the window opens; apps that map it to `focus: false` keep doing that.
- 05f72cd: `dragBy`, `dragTo` and `mouse.drag` drive a drag on a live window when the app drives its own renderer in-process (`connectTest(liveRendererAsTest(renderer))`). The live renderer delivers a press and a release to the page at once but a move only on a later turn of the event loop, so a drag stepped in one synchronous burst reached the page as press, release, then the moves, and a handle that ends its drag on `pointerup` never moved. `liveRendererAsTest` now waits one event-loop turn after every input it simulates, and `TestAutomationRenderer`'s input methods may return a promise.
- 6a78fe8: `kind: 'panel'` in the window options opens the window as a non-activating panel: a normal window (titlebar, resizing, buttons, appearance, background, normal window level) that can be the key window without activating the app. With `focus: true` it is key while the frontmost app stays frontmost, so a capture can show the key look (glass tints, accent colours, traffic lights) that a `focus: false` window never has. `renderer.isWindowKey()` reads whether AppKit reports the window as key. An unknown `kind` throws; `'normal'` is the default, and on Windows and Linux a panel is a normal window. A panel takes the keyboard like any key window, so open one only for a capture and close it right after.
- Updated dependencies [52fd03d]
- Updated dependencies [a2d57e7]
- Updated dependencies [d70feb5]
- Updated dependencies [05f72cd]
- Updated dependencies [7da4cea]
- Updated dependencies [bb3412f]
- Updated dependencies [6a78fe8]
- Updated dependencies [a6de850]
- Updated dependencies [ff5975c]
  - @ghia/native@0.11.1

## 0.11.0

### Minor Changes

- c4437f3: First Ghia release, forked from gpuix 0.10.0. See docs/fork/index.md for what changed.

### Patch Changes

- Updated dependencies [c4437f3]
  - @ghia/native@0.11.0
