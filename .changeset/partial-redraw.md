---
'@ghia/native': patch
---

Experimental, off by default: `GPUIX_PARTIAL_REDRAW=1` makes a window draw only the part of the picture that a frame changed (a hover patch, a list scroll, a scrollbar's fade) and keep the rest, on macOS. The picture is the same; a patch frame costs about a third of the GPU time on the mailbox of ghia-bench and a frame built whole 8% more. `TestRenderer` gets `setPartialRedraw`, `presentFrame` and `capturePartialPicture`.
