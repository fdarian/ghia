---
'@ghia/native': patch
---

The rows of a virtual list are retained: a row that did not change is skipped and one the list scrolls by is moved, where every frame built every visible row. Only the changed row and the list around it are built. In the mailbox bench proxy a key (ArrowDown in a 10 000-message list) takes 52M instructions instead of 63M and builds 125 elements instead of 259; a chat page of `retain.perf` skips 92% of its elements at idle instead of 59%.
