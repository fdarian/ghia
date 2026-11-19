---
"@ghia/native": minor
---

Typing into an editing host (`<div contentEditable>`): text the platform's input handler gives the focused host (typed characters, dead keys, an input method's composition) and an unprevented Enter, Backspace or Delete keydown make `beforeinput` (an `InputEvent` that bubbles and can be canceled), the change to the DOM, then `input`, and the edit goes through `insertData` and `deleteContents` so a `MutationObserver` sees it and the selection follows. `InputEvent` has `targetRanges` and `getTargetRanges()`. The test renderer has `simulateEditingInput` and `simulateEditingComposition`.
