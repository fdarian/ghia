---
"@ghia/native": minor
"ghia": minor
---

`@font-face` in a sheet registers the face with the window's text system, under the family the rule names: `font-family`, `src` (`url()` of a path, a `file://` or a `data:` URL, and `local()`, with `format()` hints), `font-weight`, `font-style`, `font-stretch` and `unicode-range`, under `@media`, `@supports` and `@layer`. TrueType, OpenType, WOFF and WOFF2 files load; a file that cannot load is skipped with a reason and the next `src` item is tried. Text that uses the family is laid out again once the face is there. `ghia()` inlines a font that CSS text (`import css from "./app.css?inline"`) refers to as a `data:` URL in `ghia dev` and `ghia build`, which is what a sheet can load.
