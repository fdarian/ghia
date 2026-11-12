---
"ghia": patch
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

A full reload under `ghia dev` unmounts the roots (and keeps the window) before it runs the entry again, as a page reload does. What the entry writes to `document` before `render()` (`document.documentElement.classList.add("dark")`, `document.body.addEventListener(...)`) used to land on the outgoing root's `<html>` and `<body>`, which `render()` then destroyed; it now goes to the stand-ins and carries to the new root's elements once. `@ghia/native/roots` exports `unmountAllRoots()`, and `registerRoot()` is how an adapter's root joins it. A `stop` that throws is logged and the reload goes on.
