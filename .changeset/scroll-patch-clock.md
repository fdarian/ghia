---
'@ghia/native': patch
---

A wheel event over a `<virtual-list>` in the draw of a tick is drawn whole: a translate builds nothing, so it took the tick (a CSS transition, a keyframe animation, a motion value, the blink of a caret) and nothing asked for the next frame, and what followed the clock stood still until a frame was built whole. The frame is `Clock` in `getPatchCounters().scrollPatch.reasons`, for a tick requested for the draw or a last frame that asked for another, and the translates resume when nothing runs.
