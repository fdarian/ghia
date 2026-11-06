---
'@ghia/solid': patch
'@ghia/native': patch
---

A node Solid removes is out of the native tree at once, as `removeChild` takes it out of the document, and a layout read in the same turn no longer lays out the removed subtree. The host used to detach it on the JS side and tell native only at the flush, so `getBoundingClientRect` or `scrollHeight` right after a keyed `<Show>` swap built and laid out the old subtree beside the new one (the mailbox navigate proxy: a detail scroller with twice its children in the pass, 56 elements built there for 40 now). `removeHostNode` now queues a new `detachChild` op, which takes the element out of its parent and keeps it, with its state, for an insertion that puts it back; the element is still destroyed at the flush if it stayed out.
