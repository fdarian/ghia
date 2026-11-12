---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`element.classList` is a live `DOMTokenList` over the `class` attribute (`add`, `remove`, `toggle` with `force`, `replace`, `contains`, `item`, `length`, `value`, iteration, `toString()`). It writes through the same path as `setAttribute('class')`, so stylesheets and `MutationObserver` see it, and it works on mounted, created and stand-in elements. `DOMTokenList` is a global. Libraries that toggle a `dark` class on `document.documentElement` with `classList` no longer throw.
