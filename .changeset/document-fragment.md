---
"@ghia/native": minor
---

`document.createDocumentFragment()` makes a real `DocumentFragment`: it holds children, is never mounted, and inserting it (`appendChild`, `insertBefore`, `replaceChild`, `append`, `before`, `Range.insertNode`, ...) moves its children in order. `Range.cloneContents()`, `extractContents()` and `surroundContents()` are there.
