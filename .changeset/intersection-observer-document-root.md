---
"@ghia/native": minor
---

`IntersectionObserver` takes a `Document` as `root`, which is the window, as in the DOM: `rootMargin` applies to it, `observer.root` returns the document, and floating-ui's `autoUpdate` (`root: element.ownerDocument`) runs unchanged. A root that is neither an element nor a document throws a `TypeError`.
