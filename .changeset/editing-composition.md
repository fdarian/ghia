---
"@ghia/native": minor
---

An input method composes in a focused `contenteditable`: marked text, a dead key (Option+E, then E) and a commit fire `compositionstart`, `beforeinput` (`insertCompositionText`), `compositionupdate`, `input` and `compositionend` in Chrome's order, and the platform is told where the marked text is (the candidate window) and which character a point is on. The composition ends with `compositionend` when the host loses focus. `simulateComposition` now composes in an editing host through the same text input, and the test renderer has `getInputMethodBounds` and `getInputMethodIndexAtPoint`.
