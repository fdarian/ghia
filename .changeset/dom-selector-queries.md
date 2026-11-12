---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`matches`, `closest`, `querySelector` and `querySelectorAll` take real CSS selectors, on elements, `document` and `DocumentFragment` (tag, class, id, attributes, the combinators, `:not`, `:is`, `:has`, `:scope`, `:disabled` and more; `:focus`, `:focus-visible`, `:focus-within`, `:hover` and `:active` ask the window). An invalid selector throws a `SyntaxError`. `matches` used to throw for anything but the five state selectors, so libraries that call these (Base UI's focus trap, floating-ui) run unchanged. Selectors are compiled once and cached; see `docs/fork/deviations.md` for what differs from Chrome.
