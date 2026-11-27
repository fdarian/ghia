---
"@ghia/native": minor
---

A stylesheet's `::before` and `::after` are drawn, with `content` (strings and `attr()`). The box is a child of its element, `::before` first and `::after` last, planned like any child: `display: inline` (the default) puts its text in the element's paragraph, so it wraps and aligns with it; `block`, `inline-block`, `flex` and `grid` boxes, flex and grid items (with `order`), and `position: absolute` and `fixed` overlays with `content: ""` work as they do for an element. A state of the element (`.btn:hover::before`, `:focus-visible`, `:disabled`) restyles its box. A pointer over a box is a pointer over its element (`elementFromPoint`, the target of an event, `:hover`), and the text of a box is not selected, copied or found. `getComputedStyle(element, "::before")` reports the used `width` and `height` of the box that was drawn. A transition or animation on a box, `counter()`, the quotes, `url()` content, `::marker` and `::first-line` are not supported.
