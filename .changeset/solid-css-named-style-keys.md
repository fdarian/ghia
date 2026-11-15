---
"@ghia/native": patch
"@ghia/solid": patch
---

A Solid `style` object's hyphenated keys are read as the CSS property they name, as on the web where Solid writes each key with `style.setProperty`: `style={{ 'white-space': 'nowrap', 'z-index': 1 }}` sets `whiteSpace` and `zIndex`. A custom property (`--gap`) keeps its name, camelCase keys keep working, and a style with no hyphenated key is not copied. The key types accept each CSS name (`SolidStyle`), with the key's own type or any CSS text or number as the value, so a `JSX.CSSProperties` stays assignable. `cssNamedStyle` in `@ghia/native/host` does the mapping.
