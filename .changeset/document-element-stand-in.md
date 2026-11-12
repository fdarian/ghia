---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`document.documentElement`, `document.head`, `document.body` and `document.scrollingElement` are never `null`. While no root is mounted the document answers with its own stand-in `<html>`, `<head>` and `<body>`, which belong to no window and read as the elements of a gone window do, and a root's real ones replace it once it mounts. floating-ui's `getOffsetParent` compared `getDocumentElement(el)` with `el.offsetParent` as `null === null` after an unmount and read `null.ownerDocument`, which was an unhandled rejection.
