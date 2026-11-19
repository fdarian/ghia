---
"@ghia/native": patch
---

The live automation client presses a `keystrokes` sequence one key at a time with a turn of the event loop after each, so an editor that commits its update in a microtask (Lexical) takes every key of "m i d" and not only the first. A synchronous `simulateKeystrokes` on the test renderer still runs a sequence inside one call; the limit is in `docs/fork/deviations.md`.
