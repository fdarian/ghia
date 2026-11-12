---
"@ghia/native": patch
---

An author `initial` or `unset` (and `inherit` on a property that inherits) in a stylesheet or an inline style takes back what the user agent and universal styles set, as in CSS: `margin: unset` on a `<p>` or an open `[popover]` loses the user agent margin, `right: unset` loses the popover's `right: 0` (a dragged `@dnd-kit` popover sits at its `left`, not centred), and `font-weight: inherit` on an `<h1>` is not bold. `revert` leaves the user agent style. `inherit` on a property that does not inherit, and a keyword inside a state style or an `@container` block, are still dropped.
