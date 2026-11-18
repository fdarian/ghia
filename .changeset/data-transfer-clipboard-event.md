---
"@ghia/native": minor
---

`DataTransfer`, `DataTransferItemList`, `DataTransferItem` and `ClipboardEvent` are globals. `new DataTransfer()` is an empty read/write store with `items`, `types`, `files`, format normalisation and the DOM's read-only and protected modes, and the `dataTransfer` of a drag is an instance of it. `copy`, `cut` and `paste` are `ClipboardEvent` types with `onCopy`, `onCut` and `onPaste` props in React and Solid.
