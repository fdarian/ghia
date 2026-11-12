---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`<input>` and `<textarea>` have the constraint validation API: `required`, `name`, `form`, `willValidate`, `validity` (`valueMissing` and `customError`; the other conditions read `false`), `validationMessage`, `setCustomValidity()`, `checkValidity()` and `reportValidity()`. Base UI's `Field` reads `validity.valueMissing` on every change and threw `Cannot read properties of undefined (reading 'valueMissing')` as an unhandled rejection. `ValidityState` is a global.
