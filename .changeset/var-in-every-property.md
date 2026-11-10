---
"@ghia/native": patch
---

`var()` works in every style property, as in CSS, not only the transform ones: `width: "var(--anchor-width)"`, `maxHeight`, `backgroundColor`, `border` and the rest read the custom properties the element computes to (its own and its ancestors', in a style, a state style and an `@container` block), with a fallback. A declaration that cannot be resolved is invalid at computed-value time and unsets its property, and written order against shorthands holds. This is what `@base-ui/react` needs to size its popups. A transition runs from and to the computed value of a `var()`.
