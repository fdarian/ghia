---
'@ghia/native': patch
---

Recording a subtree for retention is cheaper: a retained root keeps its recording state boxed (4 KB to about 100 bytes moved at each phase) and builds its id once, and the tape of a root that is built again is the last build's, emptied in place. Recording a column of 50 rows costs 13% fewer instructions (66.55M to 57.75M); a frame that replays or patches is unchanged.
