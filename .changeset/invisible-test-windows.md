---
"@ghia/native": patch
---

macOS tests: `bindTestRendererScope` sets `GHIA_TEST_INVISIBLE_WINDOWS=1`, which makes every window a `GpuixRenderer` opens in the worker or a process it spawns fully transparent, deaf to the mouse and above other apps' windows (a window with `focus: true`, the default, still becomes key), so a suite no longer flashes windows on the screen and its display-link tests are not skipped as occluded; `=0` shows them again. The `test-support` feature is on in the published addon, so any process with the variable set gets invisible windows; only `bindTestRendererScope` sets it
