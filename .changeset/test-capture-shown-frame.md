---
'@ghia/native': patch
---

The test renderer has `captureShownFrame(path)`, which saves the frame that was drawn last as it is: `captureScreenshot` notifies the view and refreshes the window first, so it could only show a frame built whole, never what a patched tick or a frame that moved the rows of a `<virtual-list>` in place drew.
