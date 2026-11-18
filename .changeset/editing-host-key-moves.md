---
"@ghia/native": minor
---

A focused `contenteditable` host moves the caret and deletes by word and line from the keyboard, as Chrome on macOS does: Left and Right by character (a range collapses to its edge), Option by word, Cmd to the row boundary; Up and Down by painted row keeping the column, Cmd to the start or end of the host; Shift extends each, and Shift+Home and Shift+End extend to the host's edges. Cmd+A selects the host's contents, the Emacs moves Ctrl+B, F, N, P extend with Shift, Ctrl+H and Ctrl+D delete, and Option+Backspace, Option+Delete and Cmd+Backspace fire `beforeinput` with `deleteWordBackward`, `deleteWordForward` and `deleteSoftLineBackward` and `targetRanges` before they change the DOM. Each is a `keydown` default, so `preventDefault()` stops it. Bindings Ghia does not do are listed in `docs/fork/deviations.md`.
