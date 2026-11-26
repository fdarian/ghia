---
"@ghia/native": minor
---

A stylesheet reads `:hover`, `:active`, `:focus` and `:focus-within` outside the subject of a selector: `.card:hover .title`, `.group:hover > .x`, `.peer:focus ~ .y`, `.menu:focus-within .item`, `li:hover + li`, `.a:active .b` and Tailwind v4's `group-hover:`, `group-focus:`, `peer-hover:` and `peer-focus:` output no longer drop the rule. The elements a state reaches match again as the pointer and the focus move; a state in the subject keeps compiling into the `hover`, `active`, `focus`, `focusVisible` and `focusWithin` blocks, and a document with no rule that reads a state outside its subject does nothing for a move of the pointer or the focus. A state inside `:has()` is still invalid.
