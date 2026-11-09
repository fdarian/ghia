---
'@ghia/native': patch
---

A window on macOS draws only the part of the picture that a frame changed (a hover patch, a list scroll, a scrollbar's fade) and keeps the rest. It is always on, with no option and no environment variable. The picture is the same; a patch frame costs about a third of the GPU time on the mailbox of ghia-bench and a frame built whole 8% more. A scene with an effect group or a surface, a transparent window and a window with native views are drawn whole. `TestRenderer` gets `presentFrame` and `capturePartialPicture`. `GPUI_GPU_TIMES=<file>` logs the kind, GPU time and damage of each presented frame.
