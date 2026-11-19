---
"@ghia/native": minor
---

The caret of an editing host is painted: a collapsed selection inside a focused `contenteditable` in a key window draws a 2px caret a row high in the theme's caret colour, solid when it moves or comes and blinking every 500 ms like an `<input>`'s. A blink is a patched frame that builds only the paragraph that holds the caret, and a host that has no focus or a window that is not key asks for no frame. `getPaintedNodeSelection()` in the test renderer now returns `{ washes, caret }`.
