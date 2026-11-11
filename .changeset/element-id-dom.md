---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

Breaking: `id` on a host element is now the DOM's `id`, the `id` prop as a string (`""` without one). The number native knows an element by, which the renderer methods take (`renderer.scrollToItem(ref.id, i)`), is renamed `nativeId` on host elements and text nodes of both adapters (`renderer.scrollToItem(ref.nativeId, i)`). `FocusableNode` and `ObservableElement` take `nativeId` too.
