---
"@ghia/native": minor
---

Typing into an editing host (`<div contentEditable>`): a `keydown` that is not prevented makes `beforeinput` (an `InputEvent` that bubbles and can be canceled), the change to the DOM, then `input`, for a printable key, Enter, Backspace and Delete, and the edit goes through `insertData` and `deleteContents` so a `MutationObserver` sees it and the selection follows. `InputEvent` has `targetRanges` and `getTargetRanges()`. The test renderer has `simulateEditingInput` and `simulateEditingComposition`.
