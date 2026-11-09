---
'@ghia/native': patch
---

A plain text is one gpui element instead of a wrapper div, an underlay canvas and the glyphs (three drawables, three layout nodes and three dispatch nodes fewer per text), so building a row of ghia-bench's mailbox costs about 190k instructions less (50 rows built whole: 1188.7k to 998.5k a row), a patched hover crossing 10% less and a keystroke of the navigate phase 4% less. Selection, find highlights, the cull outset and the pictures are the same. A paragraph with a ring, an opacity group, a cursor or region hitbox, a focus anchor or an atomic inline keeps the wrapper.
