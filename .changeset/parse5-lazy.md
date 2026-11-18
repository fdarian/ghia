---
"@ghia/native": patch
---

The HTML parser (parse5) loads on the first `DOMParser.parseFromString`, `innerHTML`, `outerHTML`, `insertAdjacentHTML` or HTML paste and not at startup, so a plain app starts with 0.4 MB less JS heap and, run from the bundle, 12 to 17 ms and about 2.5 MB less footprint. The web (wasm) build no longer bundles parse5.
