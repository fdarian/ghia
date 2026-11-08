# ghia

## 0.12.0

### Minor Changes

- 9d68f3b: `ghia dev [entry]` and `ghia build [entry]` take the app entry as an optional argument, resolved against the Vite root, which replaces the `entry` option of `ghia()` (so one Vite config can serve several entry files). `dev()` and `build()` take it as the `entry` option, and it is the input of the `ghia` build.
- 3a1421b: New package: `ghia`, the toolchain for Ghia apps, in one install like `vite` or `astro`. `ghia({ entry, server })` is a Vite plugin that defines a `ghia` environment whose modules resolve like a browser page's (browser export conditions, every dependency bundled except `@ghia/native` and its subpaths, which load natively) and injects `@ghia/native/dom-globals` ahead of the entry. The `ghia` command runs under Bun: `ghia dev` runs the app with HMR, and `ghia build` emits `dist/main.js` (which runs with plain `bun`) and compiles it into `dist/app`, one executable that embeds Bun and the native addon (about 128 MB); both take `-c, --config <file>`, `ghia build --no-compile` skips the compile, and the `compile: { outfile }` option of `ghia()` moves the binary. The same two are exported as `dev(options)`, which resolves to a handle that can `close()`, and `build(options)`, which takes `compile: false` for `--no-compile`. With `server`, a second `server` environment runs your server code in a Bun Worker, and the UI reaches it through the `serverPort` `MessagePort` from `virtual:ghia/server` (types in `ghia/client`); the server entry is `export default function serve(port)` and returns a function that detaches its handler, and `ghia build` also emits `dist/server.js`, which the compiled binary carries. The built UI reports an error from the server Worker instead of waiting on a port nobody answers. An edit to a server module reloads the server in dev, on the same port; a call in flight at that moment may go unanswered. Under vitest, `ghia()` applies the same resolve conditions, inlines every dependency, loads the addon natively and installs the globals before each test file. A full reload of the UI in `ghia dev` clears the module runner's caches, HMR data included, before it runs the entry again, so hot updates keep working after a reload and the old run's modules can be collected.

### Patch Changes

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
