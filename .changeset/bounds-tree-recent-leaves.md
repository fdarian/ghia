---
'@ghia/native': patch
---

Draw orders cost less to work out: gpui's bounds tree checks the last 16 bounds it was given before it searches, and stops at one that encloses the new bounds, as a row's background encloses its text. The orders are the same. The scroll of the mailbox app of ghia-bench takes 7.50M instructions a tick against 7.87M, its patched ticks 2.93M against 3.37M, and a row's hover background no longer costs anything in a scroll.
