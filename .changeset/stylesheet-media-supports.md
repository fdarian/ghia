---
"@ghia/native": minor
---

Stylesheets read `@media` and `@supports`. A rule inside `@media` (at the top of a sheet, in an `@layer`, in another `@media` or `@supports`, or inside a style rule) applies while its query matches the window, and follows a resize across a breakpoint, the appearance (`prefers-color-scheme`) and the OS accessibility options (`prefers-reduced-motion`, `prefers-contrast`); the features are those of `matchMedia` plus `resolution`. `@supports (property: value)` and `@supports selector(...)` are decided when the sheet is read. `cssRules` lists them as `CSSMediaRule` and `CSSSupportsRule`.
