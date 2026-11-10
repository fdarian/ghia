---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

Every window root is `<html>` > `<head>` + `<body>`: `document.head` is a real `display: none` element before `body` (no box, children never drawn), so `documentElement.children` is `[head, body]` and a library can prepend a node to it. `window` gets `innerWidth` and `innerHeight` (the window's content size in CSS pixels, live), `visualViewport` (`width`, `height`, `offsetLeft`, `offsetTop`, `pageLeft`, `pageTop`, `scale`, and a `resize` event on `addEventListener`), `frameElement`, and `parent`, `top` and `self` where the runtime has none. `getComputedStyle`, `matchMedia` and `IntersectionObserver` are globals unless the runtime has its own.
