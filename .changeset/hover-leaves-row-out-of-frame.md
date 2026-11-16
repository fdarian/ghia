---
"@ghia/native": patch
---

A hover that follows a scroll is a patch when the row it leaves is one the scroll took out of the frame. The hover follows late (when the scroll ends or a build changed the page), so the previous hover is usually a row of a `<virtual-list>` that the frame shown no longer holds; the patch declined it as `Hover` and drew a frame built whole.
