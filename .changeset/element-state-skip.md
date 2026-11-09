---
'@ghia/native': patch
---

A div keeps gpui's interactive element state only when something reads it (focus, scrolling, a click, drag or hover listener, an active or hover style, a tooltip), so a plain host div with an id skips three element-state map round trips per frame: 50 rows built whole cost 21k fewer instructions a row, a patched list crossing 3.110M to 2.993M. A mouse press over a plain div no longer asks the window to refresh. This is an engine patch in the zed fork, always on.
