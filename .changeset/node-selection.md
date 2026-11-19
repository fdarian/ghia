---
"@ghia/native": minor
"@ghia/react": patch
"@ghia/solid": patch
---

`getSelection()` holds a live `Range` of nodes once code selects them: `anchorNode`, `focusNode`, `direction`, `getRangeAt`, `addRange`, `removeRange`, `collapse`, `extend`, `setBaseAndExtent`, `selectAllChildren`, `containsNode`, `deleteFromDocument`, `getComposedRanges` and `modify` by character and word, with the DOMExceptions of the standard. A node selection and the painted text a drag selects replace each other. `document` hears one coalesced `selectionchange` per burst of changes, including a move caused by a tree or data change. `focus()` on an editing host puts a caret at its start.
