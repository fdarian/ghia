---
'@ghia/native': patch
---

The tick that follows a frame that moved the rows of a `<virtual-list>` in place (the blink of a caret, a transition) is a patch again: the translate left the view the scroll had notified on the queue, so the tick declined for a pending view and was drawn whole.
