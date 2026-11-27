---
"@ghia/native": minor
"ghia": minor
---

WOFF and WOFF2 fonts load: an `@font-face` `src` of `url(font.woff2) format("woff2")` (a path, a `file://` URL or a `data:` URL), `registerFont()` and the window `fonts` option take `.woff` and `.woff2` files as well as `.ttf` and `.otf`, and `@supports font-format(woff2)` is true. A broken file, or one without the family, full or PostScript name or an "m" glyph, is skipped with a log, and the next `src` item is tried. `ghia()` turns a `.woff` or `.woff2` `url()` in the CSS of a Vite app into a `data:` URL, as it does for `.ttf`. macOS reads both through Core Text, which the zed fork now hands them to.
