---
"@ghia/native": patch
"@ghia/solid": patch
---

Solid JSX written with the HTML attribute names works: `<input autofocus />`, `<div tabindex={0}>`, `<input readonly maxlength={4}>`, `<td colspan={2}>` and `<label for="x">` set `autoFocus`, `tabIndex`, `readOnly`, `maxLength`, `colSpan`, `rowSpan` and `htmlFor`, where the lowercase prop was stored and native never read it. `for` is `htmlFor` on every element, not only `label`. The types accept the lowercase names as solid-js's do, so a library written for solid-js type-checks. A boolean attribute given a text is on (`autofocus=""`), as in a template; an `<svg>` keeps `tabindex` and `autofocus` lowercase, as in Chrome. React does not map these names: see the deviations.
