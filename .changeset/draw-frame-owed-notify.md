---
'@ghia/native': patch
---

The test renderer's `drawFrame()` covers every batch applied before it. A key handler that read layout and then applied one more batch left a notify owed after the frame, and the next simulated input redrew the unchanged page: one extra painted frame and about 18M instructions per key in the mailbox bench proxy.
