---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

The last small DOM members that real Base UI and `@floating-ui` read are there, so they run unchanged. An element has `offsetParent`, `offsetLeft`, `offsetTop`, `clientLeft`, `clientTop` and `getClientRects()` (read from the laid-out box, and an empty list or 0 for an element with no box), `hidden` (the attribute, and `display: none` by the user agent style as in Chrome, so an author `display` is over it), `tabIndex` (the attribute, else the tag's default), `isContentEditable` (always `false`), and `shadowRoot` and `assignedSlot` (always `null`). `document.getElementById(id)` and `document.createElement(name)` exist; `createElement` makes an element that is in no tree, for a library to measure or feature-test with (it cannot be inserted). `HTMLInputElement`, `HTMLTextAreaElement`, `DOMRect` and `DOMRectReadOnly` are globals, and `window.scrollX` and `scrollY` are 0. The `hidden` prop now reaches native on every element.
