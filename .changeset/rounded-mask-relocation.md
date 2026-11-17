---
"@ghia/native": patch
---

Scrolling inside a rounded `overflow: hidden` panel or card builds fewer rows. A retained row under a rounded content mask used to be built again on every scroll frame; it is now moved when it stays clear of the mask's rounded corners, and only the rows that reach a corner are built. Where a row is clear of the corners the pixels are near those of painting under the rounded mask (paths cut by an unsnapped mask may differ), and a row that reaches a corner is built.
