---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`setAttribute`, `removeAttribute` and `toggleAttribute` on every element write the prop the attribute stands for, through the framework's own prop path, so a library written for the DOM has its effect: `aria-hidden`, `inert`, `tabindex` and `data-*` set by Floating UI's `markOthers` or Base UI's focus manager reach native at once, and `getAttribute`, `getAttributeNames`, `dataset` and `MutationObserver` records see them. A later React or Solid commit of the same prop overwrites the attribute, as in the DOM. `style` and `on*` are kept as text for `getAttribute` and do nothing else (see deviations). On an `<input>`, `setAttribute('checked')` writes `defaultChecked` and `setAttribute('value')` writes `defaultValue` (the control follows them only while it is clean), as in the DOM; the `value` attribute of a checkbox, radio, hidden, submit, button, reset or image input is its value itself. A text input or textarea given a `defaultValue` shows it until it is given a `value` or the user edits it.
