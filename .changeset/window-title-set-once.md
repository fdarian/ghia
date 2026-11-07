---
'@ghia/native': patch
---

The window title is given to the platform window when it changes, not on every frame. `GpuixView::render` called `Window::set_window_title` each time, which on macOS is an AppKit `setTitle` and an accessibility update per painted frame of a scroll. The view now keeps the title it last set and sets it again only when `setWindowTitle` (or the first render) gives it another.
