---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`element.style` keeps a property's priority, so a library written for the DOM that sets styles by hand runs unchanged: Base UI's `style.setProperty(name, 'initial', 'important')` and its restore with `getPropertyPriority`. A property written with `important` (`setProperty(name, value, 'important')`, `!important` in `cssText` or in `setAttribute('style', text)`) is held as the value with an `!important` suffix, the form a framework writes one (`display: "none !important"`), so it beats a stylesheet's `!important` rule as in Chrome; every read gives the plain value, `getPropertyPriority` reports it and `cssText` prints `display: none !important;`. A style string that holds a number for a unitless property (`opacity: '0.5'`) is now accepted. React hides a Suspense or Activity child through its live `style` as React DOM does (`setProperty('display', 'none', 'important')`), so the hidden element reads `display: none` with priority `important`, its `style` attribute has it and a `MutationObserver` records it; unhiding sets `display` to the one its props give, else `''`, which drops a `display` that code wrote meanwhile. A hidden text node is emptied, as in React DOM. Code's write of a style is deferred to the flush, and is dropped there when the element is gone or a commit already sent that style.
