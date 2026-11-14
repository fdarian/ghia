---
"@ghia/native": patch
---

Quads that are plain fills (no border, rounded corner, gradient, background tile or transform) are drawn by a light shader pair, so the root, panes and rows no longer pay for the features of the full quad shader. In the Mailbox bench the GPU time of the scroll phase fell from about 540 to 370 ms (a scroll frame from 1.15 to 0.77 ms), typing from 40 to 26 ms and navigating from 40 to 28 ms, close to GPUI alone (341, 25 and 29 ms).
