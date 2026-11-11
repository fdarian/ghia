---
"@ghia/native": patch
---

A CSS transition or animation on an element below one that goes `display: none` is cancelled (`transitioncancel`, `animationcancel`), as it is in a browser. Only an element that was built itself, in practice a window root, cancelled its own and its descendants' motion before; an element a parent no longer builds was never told. The element that goes `display: none`, or is moved below one, is now queued by the retained tree and the next frame cancels its whole subtree once.
