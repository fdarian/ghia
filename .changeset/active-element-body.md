---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`document.activeElement` is `document.body` when nothing is focused, as in a browser, where it was `null`. floating-ui's focus manager (Popover, Menu, Select) returns focus to the trigger on close only when the active element is `body`, so with `null` an Escape left focus nowhere. Code that tested `document.activeElement === null` tests `=== document.body` now.
