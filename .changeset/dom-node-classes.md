---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

Host elements and text are real DOM-shaped nodes: `el instanceof HTMLElement`, `Element` and `Node` hold (`SVGElement` for an `<svg>` and its shapes, `Text` for text), and `parentNode`, `childNodes`, `children`, the sibling members, `contains`, `getRootNode`, `compareDocumentPosition`, `textContent`, `tagName`, `localName`, `className`, `hasAttribute`, `getAttributeNames` and `dataset` answer as in a browser. `document` is a `Document`. The classes are exported by `@ghia/native/host` and installed as globals where the runtime has none. Solid's `HostElement.children` is now `childList`, because `children` is the DOM's elements-only list.
