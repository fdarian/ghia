---
"@ghia/native": patch
---

Each key event from the keyboard gets its own microtask checkpoint: `tick()` ends its pump after a `keydown`, `keyup` or modifier change and the frame loop ticks again on the next turn, so an editor that commits its update in a microtask (Lexical) applies every key that was waiting, where it used to keep the first and lose the rest. With `frameMs` set the keys that were queued together are taken one per frame. The test renderer gets `postNativeKeys` and `pumpNativeEvents` to drive that pump.
