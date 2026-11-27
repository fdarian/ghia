---
"@ghia/solid": patch
"@ghia/react": patch
---

`render()` mounts the tree before it starts the frame loop, so the window's first frame has content instead of presenting empty and filling in ~50 ms later
