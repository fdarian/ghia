---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

### Breaking changes

- **`<code code=... language=...>` is now `<code-block ...>`, and `<code>` is HTML's inline element.** The syntax-highlighted block keeps its props (`code`, `language`, `path`, `showLineNumbers`, `theme`) under the new name, so rename the tag (`<code-block code={source} language="ts" />`), the JSX type `CodeProps` to `CodeBlockProps`, and `findByType("code")` to `findByType("code-block")`. A `<code>` now lays out as `<span>` with the user agent style of Chrome's `code`: the generic `monospace` family, drawn at 13px beside 16px text by Chrome's monospace size rule (see `docs/reference.md`, "Monospace size"), so code that renders text inline in a paragraph (Lexical's Code format) works unchanged.
- **`pre`, `kbd` and `samp` use the generic `monospace` at Chrome's size**, not `Menlo` at the inherited size: they are 13px where the text around them is 16px, unless an absolute `font-size` is inherited or the `font-family` is a longer list (`monospace, monospace`). `tt` is a tag too.

### Features

- Chrome's monospace font-size rule: an element whose `font-family` becomes the generic `monospace` alone has its `font-size` scaled by 13/16 when that size is not an absolute length, and scaled back where the family stops being `monospace`.
