---
'@ghia/native': patch
---

The primitives of a frame are sorted by a sort that finds the sorted runs they come in (a row of a list at a time) and merges them: the 328 patched ticks of the mailbox scroll proxy cost 3.12M instructions against 3.26M, the ticks built whole 11.37M against 11.55M.
