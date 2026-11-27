---
"@ghia/native": minor
---

Stylesheets read `@keyframes` and `@property`. A sheet's `@keyframes` (also `@-webkit-keyframes`, at the top of a sheet and in `@layer`, `@media` and `@supports`) defines the keyframes `animation-name` plays and wins over a `defineKeyframes` of the same name; for a name the last rule wins and layers rank first, and a media-gated rule follows the window. `@property` registers a custom property for the document: its `initial-value` is what `var()` reads where nothing set it, and `inherits: false` stops it being handed down. Tailwind v4's `animate-spin` and its `@property --tw-*` initial values work. A registered property is not checked against its `syntax` or interpolated by type.
