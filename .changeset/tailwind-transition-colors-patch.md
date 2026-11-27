---
"@ghia/native": patch
---

Tailwind's `transition-colors` is a transition of colours for the patch frames of a hover: `fill` and `stroke` (and `stop-color`, `flood-color`) count as colours, a custom property in `transition-property` (`--tw-gradient-from`) names nothing Ghia transitions, and a `var()` in `transition-duration`, `transition-timing-function`, `transition-delay` or `transition-behavior` (v4's `var(--tw-duration, var(--default-transition-duration))`) no longer makes the list unknown. A `var()` in `transition` or `transition-property` still does, and so does a custom duration with no property list (the properties are `all`).
