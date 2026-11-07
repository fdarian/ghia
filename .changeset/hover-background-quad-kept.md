---
'@ghia/native': patch
---

A hover that gives an element a background it had none of is a patch frame: an element whose `hover` or `hasHover` sets a background colour paints a fully transparent background quad where it has none (gpui's new `Style::keep_transparent_background`), so the quad is in the root both ways and the hover writes a colour over it. The mailbox row of ghia-bench crosses at 4.48M instructions against 8.57M, all 18 crossings patched; the scroll phase pays the quad, 7.89M a tick against 7.64M. The page, the hit test and the pointer events are what they were.
