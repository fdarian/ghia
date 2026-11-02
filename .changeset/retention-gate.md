---
'@ghia/native': patch
---

A page that moves every root in each frame without a scroller doing it (a pan whose offset is a style) no longer pays for skipping roots it cannot replay. Retention judges each frame by what gpui replayed and what it had to build late, and while skipping loses it records and skips only a sample of the roots, coming back as soon as the sample replays again. The timeline pan with culling on costs 16 ms a frame instead of 21.5 (14.4 with retention off), and 243 ms instead of 400 with culling off. Pages whose frames replay well are unchanged. `GPUIX_RETAIN_GATE_OFF=1` turns the gate off, to time a run without it.
