---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

CSS stylesheets. A `<style>` element (`<style>{css}</style>`) and constructed sheets (`new CSSStyleSheet()` in `document.adoptedStyleSheets`, with `replaceSync`, `replace`, `insertRule`, `deleteRule` and `cssRules`) style the tree, so a library that injects CSS, such as `@dnd-kit/dom`, works unchanged. Native matches type, universal, class, id and attribute selectors, `:is()`, `:where()`, `:not()`, `:root`, the four combinators, nesting and `@layer`, merges the matching declarations with the element's `style` prop (`!important` included), and matches again only the elements a class, id, attribute or tree change can reach, once at the end of each batch. The adapters send `class`, `data-*` and other attributes to native (wire op 13) for the selectors to read; wire ops 14 and 15 carry constructed sheets. Pseudo-classes other than those above, pseudo-elements and `@media`, `@keyframes`, `@container`, `@supports`, `@font-face` and `@import` are skipped; see `docs/fork/deviations.md`. `className` is no longer a prop of the native element: it is the attribute `class`.
