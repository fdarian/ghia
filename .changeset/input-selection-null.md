---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`selectionStart`, `selectionEnd` and `selectionDirection` of an `<input>` of type `checkbox`, `radio`, `range` or `hidden` are `null`, `select()` does nothing and `setSelectionRange()` throws `InvalidStateError`, as in the DOM. They threw `Element N has no text selection`, which broke a Base UI `RadioGroup` (its composite list reads `selectionStart` of every item that takes focus).
