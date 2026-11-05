---
'@ghia/native': patch
---

The overlay scrollbar asks for no frame while it holds. After a scroll the bar stays whole for a second and then fades over 200 ms; the second used to request a frame at every vsync that painted the same bar and made every tick unpatchable (one `scrollTo` was 70 to 140 frames built whole, most of the cost of an ArrowDown through a list). One timer on the window's clock now waits for the end of the hold and only the fade asks for frames. A bar under the pointer or a held thumb asks for none while it is steady either, and a tick (a caret blink) in the hold is a patched frame, as is the blink of an input beside a list that was scrolled. A tick that finds a bar painted at an alpha the clock has since changed is still drawn whole.

A virtual-list row that the pointer had been over no longer keeps the page from patching: its hover left it in the set of elements no build had entered, so every blink beside a list under the pointer was a whole frame.
