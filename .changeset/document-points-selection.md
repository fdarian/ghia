---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`window` gets a `resize` event, sent with `visualViewport`'s when the window's size changes, from one subscription. `document.elementFromPoint(x, y)` and `elementsFromPoint(x, y)` (forced reads over `getElementsAt`, topmost first, ending with `body` and `html`), and `document.getSelection()` / `window.getSelection()` with a global `Selection` (`rangeCount`, `isCollapsed`, `type`, `toString()`, `removeAllRanges()`, `empty()`), plus a `selectionchange` event on `document` that a listener turns on in native. Events have `nativeEvent` (the event itself) and pointer events `isPrimary` (`true`).
