---
"@ghia/native": minor
---

`DOMParser` parses `text/html` into an inert `Document` (real `Element`, `Text`, `Comment` and `DocumentFragment` nodes with `style`, `querySelector`, `<template>` content and a `styleSheets` list of `CSSStyleSheet`s built from its `<style>` elements; `CSSStyleRule.style` reads a rule's declarations), and `innerHTML`, `outerHTML` and `insertAdjacentHTML` read and write markup on an element, in its context, so the new children are drawn. HTML is parsed and serialized by parse5 through a tree adapter over Ghia's own nodes. `Comment`, `StyleSheetList` and `Element.namespaceURI` are there; `textContent` skips comments. The XML MIME types and `XMLSerializer` are not supported: `docs/fork/deviations.md`.
