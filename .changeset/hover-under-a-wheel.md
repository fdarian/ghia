---
'@ghia/native': patch
---

A hover that only paints (a row that takes another background colour under the pointer) no longer holds a list's scroll as a frame built whole: a wheel over the rows of ghia-bench's mailbox is a translate for 693 of the 720 ticks of its scroll phase (396), and the tick that follows a crossing repaints the row the pointer left and the row it entered where the translate put them. A hover that more than paints, or that a listener hears, is a frame built whole as before. The scroll phase's median is 4.37M instructions a tick (5.56M), its mean 7.14M (7.6M); row crossings are 4.60M (4.62M). `getPatchCounters().scrollPatch` has `hoverAsked` and `hoverMatters`, which tell a wheel whose pointer is not where the frame shown had it from a hit chain that matters. The engine is zed at 6231b52b34: a wheel on a list goes on from where the list is now, and a patch of a row painted in its region does less work.
