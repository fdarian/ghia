---
"@ghia/native": patch
---

Stylesheets support `:has()`: `:has(> img)`, `:has(+ p)`, `:has(~ .x)` and `:has(.err)` (a relative selector list, with `>`, `+`, `~` or a descendant as the leading combinator), in any compound and inside `:is()`, `:where()` and `:not()`, so `.card:has(.err) .title`, `.btn:has(> svg)`, `h1:has(+ p)` and `.field:has(input:checked) .label` style what they name. Before, a rule that used it was dropped. A class, id, attribute, tree state or position an argument reads, and a child that comes, goes or moves, restyle only the elements that hold what the `:has()` compound requires and that are above or before the one that changed, and a sheet with no `:has()` marks nothing extra. `:has()` is not forgiving, does not nest, and takes no pointer or focus state (`:has(:hover)` is invalid; `hasHover` is the style key for that).
