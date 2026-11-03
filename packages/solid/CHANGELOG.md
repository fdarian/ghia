# @ghia/solid

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
