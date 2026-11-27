---
"@ghia/native": patch
---

macOS: a focused `<input>`, `<textarea>` or `contenteditable` caret blinks on a layer that the system's compositor animates, so an idle window with a caret submits no GPU work and wakes no JS (the GPU driver's per-process memory drains); in a contenteditable the caret is painted above the text, as in Chrome
