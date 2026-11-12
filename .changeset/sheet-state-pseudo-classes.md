---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

Stylesheets read `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` and `:popover-open`. The first five compile into the `hover`, `active`, `focus`, `focusVisible` and `focusWithin` style blocks of the element, so `.btn:hover { background: red }` is `style={{ hover: { background: 'red' } }}` on every `.btn`, with an inline value and a more specific rule beating it as in CSS. A state in a compound other than the one the rule styles (`.card:hover .title`), two states in one compound, a state inside `:not()` and an `:is()` whose arguments are under different states drop the selector. `:popover-open` matches while `showPopover()` has the popover open, in any compound. New inline style key `focus`, applied while the element is the focused one (`:focus`), under `focusWithin` and `focusVisible`.

On an element with a `transition` or an `animation`, the focus styles now fold over `hover` and `active` as on any other element, and `focus` and `focusWithin` transition. What a `focus`, `focusVisible` or `focusWithin` style sets that children inherit (`color`, `fontSize`) now reaches them, with or without a transition, as in CSS. An inline `!important` value beats the element's own `hover`, `focus` and other state blocks of that property whether or not a sheet matches the element, and a state rule that overlaps an inline side border (`.a:hover { border-color: blue }` against `borderTop`) leaves the inline side as it is. `appliedBatchCount` is no longer exported from `@ghia/native/host`.

A CSS-wide keyword in a state style takes back the base value while the state applies, in a rule under a state and in an inline block: `.a:hover { color: initial }` over `.a { color: red }` and `hover: { width: 'unset' }` over `width: 50` lose the base value on hover, `display: 'unset'` is `inline`, and `margin: 'revert'` on a `<p>` has the user agent margin. `inherit` on a property that does not inherit is still dropped.
