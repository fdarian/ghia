---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`setAttribute`, `removeAttribute` and `toggleAttribute` on every element write the prop the attribute stands for, through the framework's own prop path, so a library written for the DOM has its effect: `aria-hidden`, `inert`, `tabindex` and `data-*` set by Floating UI's `markOthers` or Base UI's focus manager reach native at once, and `getAttribute`, `getAttributeNames`, `dataset` and `MutationObserver` records see them. A later React or Solid commit of the same prop overwrites the attribute, as in the DOM. `style` and `on*` are kept as text for `getAttribute` and do nothing else (see deviations).
