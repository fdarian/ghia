---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

DOM gaps that headless Solid libraries (Kobalte, Base UI ports) hit. `input.value`, `checked`, `indeterminate` and `textarea.value` can be assigned before the element is mounted: the write is kept, reads give it back, and the control shows it once mounted (it used to throw "needs a mounted element"). `select()`, `setSelectionRange()` and `selectionStart`, `selectionEnd` and `selectionDirection` on an unmounted Solid text control answer from a selection kept on the element instead of throwing. `getElementsByTagName` and `getElementsByClassName` on elements and `document`, and `document.getElementsByName`, return live `HTMLCollection` and `NodeList` lists (also on `document.head` before a root mounts), and `HTMLCollection` and `NodeList` are globals. Assigning `className` sets the `class` attribute.
