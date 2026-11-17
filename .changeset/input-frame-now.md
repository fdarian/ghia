---
"@ghia/native": patch
---

The frame of a key, click or other input that reaches an idle window is drawn and presented by the tick that dispatched it, where it waited for the display link's first vsync (7 to 10 ms at 120 Hz) before. `GPUIX_INPUT_FRAME_OFF=1` restores the wait.
