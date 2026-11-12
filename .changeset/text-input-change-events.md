---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

Text controls fire the DOM's `input` and `change` events at the DOM's times. `input` (an `InputEvent` with `inputType`, `data`, `isComposing` and `value`, bubbling, not cancelable) fires once per edit of an `<input>` or `<textarea>`: typing, paste, cut, deletion, an input method's commit, undo and redo, and a number input's arrow step. `change` (a plain `Event` with the committed `value`, bubbling, not cancelable) fires when the user commits a changed value: on blur, before `blur` and `focusout`, when the value differs from the one at the last commit, and on Enter in an `<input>`, before its form is submitted (a number step commits itself, as in Chrome). A write to `value` from code fires neither, and drops an uncommitted edit.

Breaking, Solid and native: `onChange` and `addEventListener('change')` on a text control used to fire per edit and now fire on commit; use `onInput` or `'input'` for the per-edit event (`HostInputEvent`; `onChange` gets a `HostChangeEvent`). `ComboboxInput` (Solid) reports through `onInput`. React is unchanged for apps: React DOM's `onChange` of a text control is the `input` event, so it still fires per edit, after `onInput`, and an `onChange` on a `<form>` or a `<div>` hears the edits of the text controls below it; `onChange` of a checkbox or radio is its `change`. Use `addEventListener('change')` on a ref for the commit. A `change` event is no longer an `InputEvent`: `input` is. `getTextSelection` of the native renderer no longer carries the control's text: `selectionStart`, `selectionEnd` and `selectionDirection` read only offsets, and the text has its own `getTextValue`.
