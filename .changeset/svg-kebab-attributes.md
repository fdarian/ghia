---
"@ghia/native": patch
---

An `<svg>` child takes the kebab-case attribute names the DOM and Solid write (`stroke-width`, `stroke-linecap`, `fill-rule`) as well as React's camelCase props; before, they were dropped with a warning.
