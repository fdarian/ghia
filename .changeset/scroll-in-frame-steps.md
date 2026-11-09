---
"@ghia/native": patch
---

`onScroll` runs before the frame that paints the new offset, as a browser's `scroll` runs in "update the rendering": what its handler changes is in that frame, so a window that follows the offset (a virtualizer) shows the rows of the offset it paints, with no blank frame. `Window::set_frame_steps` in the zed fork runs the owner's steps first in every draw; a write's event is no longer a frame late, and an offset that layout moved is reported by the frame after the paint that showed it, as in Chrome.
