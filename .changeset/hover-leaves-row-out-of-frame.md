---
"@ghia/native": patch
---

A hover that follows a scroll is a patch when the row it leaves is one the scroll took out of the frame. The hover follows late (when the scroll ends or a build changed the page), so the previous hover is usually a row of a `<virtual-list>` that the frame shown no longer holds; the patch declined it as `Hover` and drew a frame built whole.

A row that holds an `overflow: hidden` box (every ellipsized line of text) is a patch under a hover after it has moved, where it was drawn whole (`Hover:Relocated`). A box only code scrolls (`scrollTop`) has an offset and an extent relative to its padding box, which moves with the row, and the bounds its scroll handle reports move with the recording; only a box the user scrolls, or one that is scrolled, still declines.
