---
"@ghia/native": patch
"@ghia/solid": patch
---

A Solid `style` object's hyphenated keys are read as the CSS property they name, as on the web where Solid writes each key with `style.setProperty`: `style={{ 'white-space': 'nowrap', 'z-index': 1 }}` sets `whiteSpace` and `zIndex`. A custom property (`--gap`) keeps its name, camelCase keys keep working, and a style with no hyphenated key is not copied. The key types accept each CSS name (`SolidStyle`), with the key's own type or any CSS text or number as the value, so a `JSX.CSSProperties` stays assignable. `cssNamedStyle` in `@ghia/native/host` does the mapping. `-webkit-app-region` (Electron's name for `appRegion`), `-webkit-line-clamp` and `-webkit-user-select` name their style keys too, in a Solid key and in `style.setProperty`. A number under a hyphenated key is px (a browser ignores it), and a state block takes camelCase keys only. Ghia's own Solid components (`DialogPortal`, `FloatingLayer`) read a `pointer-events` key as `pointerEvents`.
