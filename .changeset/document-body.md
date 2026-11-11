---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

Every window root is a real `<html>` with a `<body>` in it, and the app's top-level nodes are children of `body`, so several top-level siblings all draw (native drew only the last one). `document.documentElement`, `document.body` and `document.scrollingElement` give them for the window that mounted last (`null` with nothing mounted); `html.parentNode` is `document` and a top-level element's `parentNode` is `body`. `document.body` is a portal container (`createPortal(children, document.body)`), a pointer-capture target and a member of event paths, which now end at `html`. Both are `display: block` and fill the window, with no default margin; see the deviation in `docs/fork/deviations.md`.
