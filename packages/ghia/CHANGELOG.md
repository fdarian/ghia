# ghia

## 0.14.0

### Performance

- The HTML parser (parse5) loads on the first `DOMParser.parseFromString`, `innerHTML`, `outerHTML`, `insertAdjacentHTML` or HTML paste and not at startup, so a plain app starts with 0.4 MB less JS heap and, run from the bundle, 12 to 17 ms and about 2.5 MB less footprint. The web (wasm) build no longer bundles parse5.
- The frame of a key, click or other input that reaches an idle window is drawn and presented by the frame loop right after the tick that dispatched it and the microtasks that tick's handlers queued (as a browser paints after an input task and its microtasks), where it waited for the display link's first vsync (7 to 10 ms at 120 Hz) before. The renderer has two new methods for it, `startedLinksPending()` and `stepStartedLinks()`; `tick()` itself draws nothing. `GPUIX_INPUT_FRAME_OFF=1` restores the wait.

### Fixes

- A scroll no longer freezes while frames take longer than a vsync. The macOS pump ran display-link frame steps back to back in one tick for as long as the link had another one queued, so wheel events were not read and JS did not run for 0.1 to 2 s at a time, and the page kept presenting a frozen scroll. A tick now runs at most one frame step, and the next tick reads the events first.
- Each key event from the keyboard gets its own microtask checkpoint on both sides: `tick()` ends its pump before a `keydown`, `keyup` or modifier change when an event or a frame step came first, and after sending it, and the frame loop ticks again at once, so an editor that commits its update in a microtask (Lexical) applies every key that was waiting, where it used to keep the first and lose the rest. With `frameMs` set the timer path ticks again on the next turn of the event loop (`keyEventPending()`) instead of waiting out the frame. There is still no checkpoint between the listeners of one event or between a key's `keydown` and its `input`, and mouse events handled in one pump share one. The test renderer gets `postNativeKeys`, `pumpNativeEvents`, `setYieldAfterKeyEvent` and `keyEventPending` to drive that pump.

### Dependencies

- Updated dependencies [efdc58a]
- Updated dependencies [32cb7c2]
- Updated dependencies [dbd63d6]
- Updated dependencies [698580c]
- Updated dependencies [5493465]
- Updated dependencies [08786e0]
- Updated dependencies [1ab5788]
- Updated dependencies [c8a846d]
- Updated dependencies [76853dd]
- Updated dependencies [5340a15]
- Updated dependencies [40e4657]
- Updated dependencies [d5d8a2c]
- Updated dependencies [3ecd502]
- Updated dependencies [f610c70]
- Updated dependencies [c126e2d]
- Updated dependencies [a6a5504]
- Updated dependencies [d402189]
- Updated dependencies [bb0bcaf]
- Updated dependencies [7b8e480]
- Updated dependencies [2e41294]
- Updated dependencies [f926534]
- Updated dependencies [b3097eb]
- Updated dependencies [88ba15f]
- Updated dependencies [b0e1a44]
- Updated dependencies [08ab88f]
- Updated dependencies [4a289c4]
- Updated dependencies [7080a6a]
- Updated dependencies [a0347c3]
- Updated dependencies [7f27601]
- Updated dependencies [ed5fd5a]
- Updated dependencies [c8a846d]
- Updated dependencies [fe19c6a]
- Updated dependencies [7c06a8a]
- Updated dependencies [11ad59a]
- Updated dependencies [8d56654]
- Updated dependencies [3fce838]
- Updated dependencies [97d4d8e]
- Updated dependencies [fcc869d]
- Updated dependencies [f807bac]
- Updated dependencies [ad6380d]
- Updated dependencies [8fdb2e6]
- Updated dependencies [866fd8c]
- Updated dependencies [ed8e9ad]
- Updated dependencies [75882f5]
  - @ghia/native@0.14.0

## 0.13.0

### Breaking changes

- **`ghia()` returns two plugins** (the main one and `ghia:workers`), so code that used its result as one `Plugin` indexes into it. `ghia build` writes every chunk flat into `dist/` (no `assets/` directory), and the compiled binary no longer loads a `bunfig.toml` or `.env` from the directory it is launched in.

### Features

**Toolchain**

- `ghia build` bundles Workers the app starts with `new Worker(new URL("./file.ts", import.meta.url))`, in UI or server code, into the single executable.

### Performance

- A wheel on a scroller is a scroll write, so a scroll listener that reads `scrollTop` no longer forces a layout pass per wheel event. A caret blink is no longer a whole frame after a stylesheet sets `white-space`.

### Fixes

- A full reload under `ghia dev` unmounts the roots before running the entry again, as a page reload does.
- `ghia dev` no longer fails at startup in a directory that contains an HTML page.

## 0.12.1

### Dependencies

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

## 0.12.0

New package: `ghia`, the toolchain for Ghia apps, in one install like `vite` or `astro`.

### Features

**Toolchain**

- `ghia({ entry, server })` is a Vite plugin that defines a `ghia` environment whose modules resolve like a browser page's (browser export conditions, every dependency bundled except `@ghia/native` and its subpaths, which load natively) and injects `@ghia/native/dom-globals` ahead of the entry.
- The `ghia` command runs under Bun: `ghia dev` runs the app with HMR, and `ghia build` emits `dist/main.js` (which runs with plain `bun`) and compiles it into `dist/app`, one executable that embeds Bun and the native addon (about 128 MB). Both take `-c, --config <file>`, `ghia build --no-compile` skips the compile, and the `compile: { outfile }` option of `ghia()` moves the binary.
- `ghia dev [entry]` and `ghia build [entry]` take the app entry as an optional argument, resolved against the Vite root, which replaces the `entry` option of `ghia()` (so one Vite config can serve several entry files). `dev()` and `build()` take it as the `entry` option, and it is the input of the `ghia` build.
- The same two are exported as `dev(options)`, which resolves to a handle that can `close()`, and `build(options)`, which takes `compile: false` for `--no-compile`.
- With `server`, a second `server` environment runs your server code in a Bun Worker, and the UI reaches it through the `serverPort` `MessagePort` from `virtual:ghia/server` (types in `ghia/client`); the server entry is `export default function serve(port)` and returns a function that detaches its handler, and `ghia build` also emits `dist/server.js`, which the compiled binary carries. The built UI reports an error from the server Worker instead of waiting on a port nobody answers. An edit to a server module reloads the server in dev, on the same port; a call in flight at that moment may go unanswered.
- Under vitest, `ghia()` applies the same resolve conditions, inlines every dependency, loads the addon natively and installs the globals before each test file.
- A full reload of the UI in `ghia dev` clears the module runner's caches, HMR data included, before it runs the entry again, so hot updates keep working after a reload and the old run's modules can be collected.

### Dependencies

- Updated dependencies [8fcd806]
- Updated dependencies [7528529]
- Updated dependencies [8fe6300]
- Updated dependencies [9be6797]
- Updated dependencies [c936c56]
- Updated dependencies [d711914]
- Updated dependencies [521b773]
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
