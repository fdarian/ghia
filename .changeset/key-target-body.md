---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

A key pressed with nothing focused targets `document.body` and bubbles body, html, document, window, as in a browser, where it went to `window` alone with `target === null`. `event.target === document.body` and `event.target.closest(...)` work, and `preventDefault()` on a `body` or `html` listener cancels Tab's focus move and the scrolling keys.
