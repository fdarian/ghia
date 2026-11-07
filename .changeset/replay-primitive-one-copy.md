---
'@ghia/native': patch
---

A primitive of a recording that is put in the frame (a row built before it is shown, a row moved by a scroll translate) is copied once into the slot the log keeps it in and moved there, and no longer through a temporary and several moves: the 328 patched ticks of the mailbox scroll proxy cost 3.60M instructions against 4.08M, the ticks built whole 11.99M against 12.26M.
