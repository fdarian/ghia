---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`<input>` and `<textarea>` have the constraint validation API: `required`, `name`, `form`, `willValidate`, `validity` (`valueMissing` and `customError`; the other conditions read `false`), `validationMessage`, `setCustomValidity()`, `checkValidity()` and `reportValidity()`. Base UI's `Field` reads `validity.valueMissing` on every change and threw `Cannot read properties of undefined (reading 'valueMissing')` as an unhandled rejection. `ValidityState` is a global. Every radio of a group with a `required` radio is `valueMissing` while none is checked (native's form check agrees), `form` and `validity` follow the `form="id"` attribute, `reportValidity()` focuses the control unless `invalid` was canceled (no message bubble), and the `ValidityState` attributes are enumerable.
