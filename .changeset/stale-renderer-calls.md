---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

An element used after its window is gone no longer throws or reaches another window. The test renderer after `dispose()` or after the next test renderer replaced it, and a live renderer after its window closed, answer `getBoundingClientRect`, `getComputedStyle`, `focus()`, `blur()`, scrolling, pointer capture, `matches(":focus")`, style, attribute and listener writes and observers as a node that is not in a document does, so Base UI's focus return and floating-ui's measuring after `unmount()` are harmless; an earlier test's `focus()` used to focus the element with the same id in the next test's window. `focus()` and `blur()` of a Solid element that is not mounted do nothing instead of throwing. Event handlers called from native stop nesting at 16 levels and throw `Maximum call stack size exceeded`, where two focus handlers that moved focus to each other ran the process out of stack and napi's `Error::from(Unknown)` recursed until it aborted.
