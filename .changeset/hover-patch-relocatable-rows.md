---
'@ghia/native': patch
---

A row of a `<virtual-list>` is patched where it was recorded: a hover that only paints (a background colour over a background the row already has) is drawn by writing the primitives of the two rows over the frame shown, and no longer by a frame built whole. In the mailbox proxy of ghia-bench with rows that paint a background, a row crossing costs 4.7M instructions against 9.7M (the bench app as it is, whose hover gives the row a background it did not have, adds a quad and is still a frame built whole: 9.3M). A row the list has put elsewhere since it was recorded is a frame built whole (`unpatchable["Hover:Relocated"]`), and the frame after a patch that moves the rows by a scroll is built whole too. The patch compares the operations of a root by their fields where it formatted them (25.7M of a 27.9M tick), and a marker a recording puts elsewhere is no difference.
