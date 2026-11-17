---
"@ghia/native": patch
---

Editing hosts follow the DOM at the edges: moving an editable subtree into or out of an editing host updates what takes focus (an editable element inside an editable parent is not a tab stop), the arrow, Page, Home, End and Space keys do not scroll while an editing host is focused, and Tab or a click that focuses a host puts the caret at its start.
