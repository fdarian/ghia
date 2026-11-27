---
"@ghia/native": minor
"ghia": minor
---

`@font-face` in a sheet registers the face with the window's text system, under the family the rule names: `font-family`, `src` (`url()` of a path, a `file://` or a `data:` URL, and `local()`, with `format()` hints), `font-weight`, `font-style`, `font-stretch` and `unicode-range`, under `@media`, `@supports` and `@layer`. TrueType and OpenType files load; WOFF and WOFF2 are skipped with a reason, so list a `.ttf` source after them. Text that uses the family is laid out again once the face is there. `ghia()` inlines a font that CSS text (`import css from "./app.css?inline"`) refers to as a `data:` URL in `ghia dev` and `ghia build`, which is what a sheet can load.
