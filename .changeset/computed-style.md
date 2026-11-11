---
"@ghia/native": patch
---

`getComputedStyle(element, pseudoElt?)` is exported by `@ghia/native/host`: a synchronous read of the resolved values Chrome reports for the properties web libraries read (display, position, overflow, direction, transform and its origin, width and height, the physical and logical padding, margin and border widths, transition and animation names and durations, font-size, color, opacity, z-index and more), as camelCase members and `getPropertyValue(kebab-case)`, custom properties included. Layout-dependent values are the used px of the laid-out box, an element that is not in the document reads `""`, and `::before` and `::after` read as a pseudo-element the element does not have.
