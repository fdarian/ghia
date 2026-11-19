---
"@ghia/native": patch
---

Editing hosts follow the DOM at the edges: moving an editable subtree into or out of an editing host updates what takes focus (an editable element inside an editable parent is not a tab stop), the arrow keys and Space do not scroll while an editing host is focused (Home, End, Page Up and Page Down still scroll, as in Chrome on macOS), and Tab or `focus()` into a host puts the caret at its start (a click focuses first, then puts it at the point).
