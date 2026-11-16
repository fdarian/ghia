---
"@ghia/native": patch
---

Mounting a subtree asks the layout engine fewer questions: a node's layout input drops the parent size it does not read and a block container's available height it does not read, so equal questions share one cache entry (a Settings dialog mount sizes 2188 nodes instead of 3185, 8% fewer instructions).
