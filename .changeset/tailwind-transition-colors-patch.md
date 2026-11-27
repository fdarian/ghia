---
"@ghia/native": patch
---

Tailwind's `transition-colors` is a transition of colours for the patch frames of a hover: `fill` and `stroke` (and `stop-color`, `flood-color`) count as colours, a custom property in `transition-property` (`--tw-gradient-from`) names nothing Ghia transitions, and a `var()` in `transition-duration`, `transition-timing-function`, `transition-delay` or `transition-behavior` (v4's `var(--tw-duration, var(--default-transition-duration))`) no longer makes the list unknown. A `var()` in `transition` or `transition-property` still does, and so does a custom duration with no property list (the properties are `all`).

A hover whose colours are `var()` references (Tailwind v4's `hover:bg-blue-500`, `background-color: var(--color-blue-500)`) is a patch frame too when it resolves, against the custom properties of the element, to a pair that only paints: the rules of a literal colour pair apply, so a text or border that resolves to transparent, a hover that sets a custom property, a value that does not resolve and a `var()` outside the colour properties are still built whole.
