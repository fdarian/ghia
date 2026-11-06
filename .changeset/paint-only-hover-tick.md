---
'@ghia/native': patch
---

A hover that only changes how elements paint (a background colour, a border colour, the colour of a shadow) asks the window for a tick instead of rebuilding the view. A patch frame takes the tick when it can; when it cannot, or when patching is off, the frame is built whole in the same draw and shows the same page as before. A hover that a listener hears (`pointerenter`, `mouseover`, ...) or that changes anything else is a frame built whole, as it was.
