---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

DOM members a library such as `@dnd-kit/dom` reads. `matches`, `closest` and `querySelector` take `:popover-open`, and answer for elements `document.createElement` made before they are inserted. `setAttribute('popover', ...)` and `removeAttribute('popover')` hide a showing popover whose kind they change, as the `popover` property does. `element.style` keeps a property a browser has and Ghia has no style key for (`touch-action`, `will-change`, `scroll-snap-type`, from `mdn-data`'s property list): it reads back from `getPropertyValue`, the accessor, `cssText` and `getAttribute('style')`, and is never sent to native; a name that is no CSS property (`foo-bar`) is ignored. The `style` attribute reads `""` once code has written the style and emptied it, and `null` only before that or after `removeAttribute('style')`. New: `document.compatMode` (`"CSS1Compat"`) and the reflected `disabled` (button, input, select, textarea, fieldset, optgroup, option) and `htmlFor` (label) members.
