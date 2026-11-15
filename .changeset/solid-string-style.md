---
"@ghia/native": patch
"@ghia/solid": patch
---

A Solid host element's `style` takes a string, as solid-js types it (`CSSProperties | string`): `style="color: red; padding-top: 4px"` is CSS text, written as Solid on the web writes it with `style.cssText`, where it used to clear the style. It replaces the previous style, string or object, and `""` or `undefined` leaves no `style` attribute; what code wrote through `element.style` stays. `styleFromCssText` in `@ghia/native/host` parses the text with the parser `style.cssText` uses.
