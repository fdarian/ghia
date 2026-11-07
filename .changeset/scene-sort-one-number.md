---
'@ghia/native': patch
---

The primitives of a frame are sorted by draw order and atlas texture as one number each instead of a tuple of structs: the 328 patched ticks of the mailbox scroll proxy cost 3.26M instructions against 3.60M, the ticks built whole 11.61M against 11.99M, the hover row crossings 8.60M against 9.12M.
