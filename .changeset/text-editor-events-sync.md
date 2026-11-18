---
"@ghia/native": patch
---

The text editor's events (`input`, `compositionstart`, `compositionupdate`, `compositionend` and the number stepper's `change`) reach JS synchronously on macOS and in the test renderer, as `keydown` does: after the edit and before the key's `keyup`, in order, in the same tick as the key. A controlled input's echo is drawn by the frame of the key that typed it, where it waited for the next tick before. They are still queued on Windows and Linux.
