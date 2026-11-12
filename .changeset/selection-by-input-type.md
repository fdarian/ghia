---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`selectionStart`, `selectionEnd` and `selectionDirection` of an `<input>` are `null`, `select()` does nothing and `setSelectionRange()` throws `InvalidStateError` for every type except `text`, `search`, `url`, `tel` and `password`, as HTML says; `email`, `number`, `date` and the others used to have a selection. The `type` is read trimmed and lowercased, as native does, with an unknown keyword counting as `text`.
