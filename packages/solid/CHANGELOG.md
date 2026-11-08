# @ghia/solid

## 0.12.0

### Minor Changes

- 9d68f3b: `solid({ include, exclude })` compiles only the files it names, for an app that also uses `react()` from `@ghia/react/vite`.
- 4c7d9c6: The Bun preload and `@ghia/solid/bun-plugin` are removed, along with the compile cache and the Babel dependencies they used: run Solid apps with `ghia dev` and `ghia build` from `ghia`. `solid()` from `@ghia/solid/vite` compiles JSX for the universal renderer (`moduleName: "@ghia/solid"`) with Solid HMR in `ghia dev`, so an edited component updates without a reload, and it also compiles under vitest. `@ghia/solid` re-exports `isWebBuild`. Apps need `@ghia/native` as a direct dependency. In `ghia dev`, a full reload no longer logs `You appear to have multiple instances of Solid`: `solid()` resets the flag at the start of each run, and a real second copy of `solid-js` inside one run still warns. `render()` reports native errors to the `onUncaughtError` of its latest call instead of the first one's.

### Patch Changes

- 9bce77d: A node Solid removes is out of the native tree at once, as `removeChild` takes it out of the document, and a layout read in the same turn no longer lays out the removed subtree. The host used to detach it on the JS side and tell native only at the flush, so `getBoundingClientRect` or `scrollHeight` right after a keyed `<Show>` swap built and laid out the old subtree beside the new one (the mailbox navigate proxy: a detail scroller with twice its children in the pass, 56 elements built there for 40 now). `removeHostNode` now queues a new `detachChild` op, which takes the element out of its parent and keeps it, with its state, for an insertion that puts it back; the element is still destroyed at the flush if it stayed out.
- f6b9458: Solid no longer queues a `setStyle` or `setCustomProp` for a value the element already has. An effect that ran again and built an equal style object (a row whose style reads `selected`, an `aria-label` and a style in one effect) sent the whole style to native every time: in the bench's mailbox app, 180 identical `setStyle` ops and 27 KB of JSON for a key that changed nothing. The host remembers the JSON it last wrote for each element's style and custom props and writes only what differs from it, so a style object changed in place and passed again is still written, and so is a key order that differs. A prop never written is written, and a new native element starts with nothing written. `@ghia/native/host` exports `SentWrites`.
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
