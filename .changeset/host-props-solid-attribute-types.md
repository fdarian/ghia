---
"@ghia/native": patch
"@ghia/solid": patch
"@ghia/react": patch
---

Host props take what solid-js types for the same DOM attribute, so `JSX.HTMLAttributes` spreads onto a host element: `draggable` is `boolean | "true" | "false"` (a text is read as the DOM's enumerated value, `"false"` is off and `"true"` on), `popover` takes a boolean (`true` is `auto`), the numeric `aria-*` props take text, `aria-rowindextext` and `aria-colindextext` take a number, and a button's `type` takes the obsolete `"menu"`. A text given for `tabIndex`, `maxLength`, `colSpan`, `rowSpan` or `span` is the integer it holds.
