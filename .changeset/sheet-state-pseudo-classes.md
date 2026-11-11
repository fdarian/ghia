---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

Stylesheets read `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` and `:popover-open`. The first five compile into the `hover`, `active`, `focus`, `focusVisible` and `focusWithin` style blocks of the element, so `.btn:hover { background: red }` is `style={{ hover: { background: 'red' } }}` on every `.btn`, with an inline value and a more specific rule beating it as in CSS. A state in a compound other than the one the rule styles (`.card:hover .title`), two states in one compound, a state inside `:not()` and an `:is()` whose arguments are under different states drop the selector. `:popover-open` matches while `showPopover()` has the popover open, in any compound. New inline style key `focus`, applied while the element is the focused one (`:focus`), under `focusWithin` and `focusVisible`.
