---
"@ghia/native": patch
---

A window with native views no longer grows while it draws: the published addon kept a record of every composed frame (about 2.4 MB per 1000 frames on the Apple Music clone). The GPUI layers above a native view share the window's pipelines and command queue, keep two drawables instead of three, and hold none while they have nothing to draw. A transitioning element with no state style to fold no longer copies its style.
