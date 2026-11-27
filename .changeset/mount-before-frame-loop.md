---
"@ghia/native": patch
"@ghia/solid": patch
"@ghia/react": patch
---

`render()` mounts the tree before it starts the frame loop, so the window's first frame has content instead of presenting empty and filling in ~50 ms later

The frame loop's first tick is a task of its own, after the microtasks the mount queued and the code after `render()`, and a mount that throws still starts the loop.
