---
'@ghia/native': patch
'@ghia/react': patch
'@ghia/solid': patch
---

`dragBy`, `dragTo` and `mouse.drag` drive a drag on a live window when the app drives its own renderer in-process (`connectTest(liveRendererAsTest(renderer))`). The live renderer delivers a press and a release to the page at once but a move only on a later turn of the event loop, so a drag stepped in one synchronous burst reached the page as press, release, then the moves, and a handle that ends its drag on `pointerup` never moved. `liveRendererAsTest` now waits one event-loop turn after every input it simulates, and `TestAutomationRenderer`'s input methods may return a promise.
