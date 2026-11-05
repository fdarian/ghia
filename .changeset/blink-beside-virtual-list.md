---
'@ghia/native': patch
---

The blink of a focused `<input>` is a patched frame that builds the input alone when the page holds a `<virtual-list>`. A virtual list or one of its rows made the frame before it unsteady (`Exclusion::varies_with_time`), so every tick of a loop or caret elsewhere on the page was drawn whole and rebuilt the visible rows (about 2.4 ms a blink in a mail client with a search box). A list is painted as the frame that built it left it, and what changes it afterwards (a scroll, a new window of rows, an animation in a row) is a source of its own, so a tick no longer waits for it.
