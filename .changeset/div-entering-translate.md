---
"@ghia/native": patch
---

Scroll perf: a wheel step over a `div` scroller whose commit puts absolutely positioned children in it (the rows a virtualizer starts rendering), with or without taking others out, is drawn as a translate that builds the children that came in in a scratch frame and puts them in the frame beside the root that stays next to them, instead of a frame built whole. A child that names its `top`, `width` and `height` inside its positioned parent and holds no input, image, motion or transition comes in this way; anything else is drawn whole as before
