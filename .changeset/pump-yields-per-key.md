---
"@ghia/native": patch
---

Each key event from the keyboard gets its own microtask checkpoint on both sides: `tick()` ends its pump before a `keydown`, `keyup` or modifier change when an event or a frame step came first, and after sending it, and the frame loop ticks again at once, so an editor that commits its update in a microtask (Lexical) applies every key that was waiting, where it used to keep the first and lose the rest. With `frameMs` set the timer path ticks again on the next turn of the event loop (`keyEventPending()`) instead of waiting out the frame. There is still no checkpoint between the listeners of one event or between a key's `keydown` and its `input`, and mouse events handled in one pump share one. The test renderer gets `postNativeKeys`, `pumpNativeEvents`, `setYieldAfterKeyEvent` and `keyEventPending` to drive that pump.
