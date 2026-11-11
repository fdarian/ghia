---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

Code that is not the framework can build and move DOM nodes, mixed with the nodes React or Solid made, as in a browser: `document.createElement`, `createElementNS` and `createTextNode`, `appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `remove`, `before`, `after`, `replaceWith`, `append`, `prepend`, `replaceChildren`, `insertAdjacentElement`, `insertAdjacentText`, and the `textContent`, `nodeValue` and `data` setters, with the DOM's return values and `DOMException` names. A node code removes is kept, and native drops its element at the next flush unless the node is back in the document by then. `MutationObserver` hears every change, and the framework's next update works on the tree the code left. Adapters implement `ParentBinding` (`assertSameWindow`, `insertBefore`, `removeChild`, `createText`, `createElement`) and `TextBinding.setData` on their `DOM_BINDING`, and register a `DomNodeFactory` with `installElementSource`. React's mutation queue now flushes in a microtask, so changes made outside a commit reach native.
