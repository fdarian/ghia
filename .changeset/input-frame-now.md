---
"@ghia/native": patch
---

The frame of a key, click or other input that reaches an idle window is drawn and presented by the frame loop right after the tick that dispatched it and the microtasks that tick's handlers queued (as a browser paints after an input task and its microtasks), where it waited for the display link's first vsync (7 to 10 ms at 120 Hz) before. The renderer has two new methods for it, `startedLinksPending()` and `stepStartedLinks()`; `tick()` itself draws nothing. `GPUIX_INPUT_FRAME_OFF=1` restores the wait.
