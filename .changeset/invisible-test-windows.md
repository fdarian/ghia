---
"@ghia/native": patch
---

macOS tests: `bindTestRendererScope` sets `GHIA_TEST_INVISIBLE_WINDOWS=1`, which makes every live window a test opens (here or in a process it spawns) fully transparent, deaf to the mouse and above other apps' windows, so a suite no longer flashes windows on the screen and its display-link tests are not skipped as occluded; `=0` shows them again. Only the `test-support` addon reads it
