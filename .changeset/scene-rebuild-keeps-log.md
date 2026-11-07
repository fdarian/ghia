---
'@ghia/native': patch
---

A frame patched by a scroll translate or by a patch whose operations moved makes its scene again from the log it already has and no longer copies every primitive into a second log: the 328 patched ticks of the mailbox scroll proxy cost 4.09M instructions against 5.07M, and the scroll mean 8.54M against 9.06M.
