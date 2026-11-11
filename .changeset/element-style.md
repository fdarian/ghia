---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`element.style` keeps a property's priority, so a library written for the DOM that sets styles by hand runs unchanged: Base UI's `style.setProperty(name, 'initial', 'important')` and its restore with `getPropertyPriority`. A property written with `important` (`setProperty(name, value, 'important')`, `!important` in `cssText` or in `setAttribute('style', text)`) is held as the value with an `!important` suffix, the form a framework writes one (`display: "none !important"`), so it beats a stylesheet's `!important` rule as in Chrome; every read gives the plain value, `getPropertyPriority` reports it and `cssText` prints `display: none !important;`. A style string that holds a number for a unitless property (`opacity: '0.5'`) is now accepted.
