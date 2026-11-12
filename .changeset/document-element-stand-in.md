---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`document.documentElement`, `document.head`, `document.body` and `document.scrollingElement` are never `null`. While no root is mounted the document answers with its own stand-in `<html>`, `<head>` and `<body>`, which belong to no window and read as the elements of a gone window do, and a root's real ones replace it once it mounts. floating-ui's `getOffsetParent` compared `getDocumentElement(el)` with `el.offsetParent` as `null === null` after an unmount and read `null.ownerDocument`, which was an unhandled rejection.

What code writes to the stand-in `<html>`, `<head>` and `<body>` before the first `render()` (attributes including `class` and `data-*`, `style`, `addEventListener` listeners) is no longer lost: when the first root mounts it is written again to that root's real elements, so `document.documentElement.setAttribute("class", "dark")` drives an `html.dark body { ... }` rule and a `keydown` listener added to `body` fires. The replaced stand-ins are then nodes in no document (`isConnected` `false`, `parentNode` `null`, not contained by `document`), where they used to claim to be connected, and the last unmount gives the document fresh ones.
