---
'@ghia/native': patch
---

Putting the operations of a recording back into the scene (the replay of a retained row, a scroll translate, and the scene made again from its log after a patch) copies each primitive twice and no more, and works out its window bounds once. It used to clone it for the log, move it through `insert`, `record` and `route`, and clone it again for the typed vector (about eight copies of the 240 bytes of a glyph sprite). In the mailbox scroll proxy a frame replays about 2700 operations, and a tick went from 12.4M to 9.8M instructions.
