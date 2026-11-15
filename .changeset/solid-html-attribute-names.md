---
"@ghia/native": patch
"@ghia/solid": patch
---

Solid JSX written with the HTML attribute names works: `<input autofocus />`, `<div tabindex={0}>`, `<input readonly maxlength={4}>`, `<td colspan={2}>` and `<label for="x">` set `autoFocus`, `tabIndex`, `readOnly`, `maxLength`, `colSpan`, `rowSpan` and `htmlFor`, where the lowercase prop was stored and native never read it. `for` is `htmlFor` on every element, not only `label`. The types accept the lowercase names as solid-js's do, so a library written for solid-js type-checks.
