---
"@ghia/native": patch
"ghia": patch
---

A caret blink, or any other patch, is no longer a whole frame after a stylesheet sets `white-space` on elements mounted in the same batch (StyleX does this for rows it appends). A wheel on a div scroller is a scroll write, as in a browser, so a scroll listener that reads `scrollTop` after it no longer forces a layout pass on every wheel event (TanStack Virtual does this). `ghia dev` no longer fails at startup in a directory with an HTML page: the unused Vite `client` environment does not scan it for dependencies.
