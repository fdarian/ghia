---
"@ghia/native": patch
---

`KeyframeEffect`, `Animation`, `CSSAnimation`, `CSSTransition` and `DocumentTimeline` are globals where the runtime has none, so a library's `effect instanceof KeyframeEffect` holds: `@dnd-kit/dom` asked it of every animation of the dragged element and threw a `ReferenceError` from the drag. They throw `Illegal constructor` when an app calls `new`. The `@dnd-kit/solid` and `@dnd-kit/react` sortable (0.5.3) now run end to end, a pointer drag and a keyboard drag with the drop animation, with no stub in the test.
