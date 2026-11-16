---
"@ghia/native": patch
---

Scrolling inside a rounded `overflow: hidden` panel or card builds fewer rows. A retained row under a rounded content mask used to be built again on every scroll frame; it is now moved when it stays clear of the mask's rounded corners, and only the rows that reach a corner are built. The pixels are the same.
