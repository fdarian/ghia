---
"@ghia/native": minor
---

An editing host follows Chrome on macOS in two more places. Home, End, Page Up and Page Down scroll the nearest scroller while a `contenteditable` has focus (the arrow keys and Space stay editing keys, and Shift+Page Up and Down scroll nothing), and a press, a drag or a double or triple click on an empty paragraph (`<p><br></p>`) puts the caret in it, as `(paragraph, 0)`, where it used to land in the nearest paragraph with text.
