---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`element.style` is a `CSSStyleDeclaration` on every element, so a library written for the DOM that sets styles by hand runs unchanged: Base UI's `style.setProperty('--drawer-swipe-movement-y', '12px')`, `setProperty(name, 'initial', 'important')` and its restore, `removeProperty`, `style.height = '…'`, `style.transform`, `style.transition` and the reads of them. It reads the element's inline style as CSS text (`height: 20` is `"20px"`), has an accessor for every CSS property, `getPropertyValue`, `setProperty`, `removeProperty`, `getPropertyPriority`, `cssText` and iteration, and `setAttribute('style', text)` and `getAttribute('style')` go through `cssText`. What is written lays over the framework's `style` and reaches layout, paint and `getComputedStyle`; a custom property feeds a `var()`. A React or Solid commit replaces only the properties it changed. Writes are queued and sent once, before the next frame and before any read that lays out, so a pointer move that writes on every event costs one style op per frame. A `MutationObserver` records `style` attribute changes. A property Ghia has no style key for is stored and read back but not applied, and `important` has no effect (see deviations). A style string that holds a number for a unitless property (`opacity: '0.5'`) is now accepted.
