---
"@ghia/native": patch
---

A layout read after a swap of class-styled content no longer builds the frame whole. A subtree taken out of the document (a Solid `<Show>` swap, `removeChild`) loses its stylesheet matches, as in a browser, and that restyle of an element no frame draws was counted as a `Structure` change that no anchor holds, so a read of `scrollTop`, `clientHeight` or `scrollHeight` in the same handler declined the patch (`Read:Structure`) and the frame was built whole. Inline-styled content was not affected. An element that is not under the window's root now records no change of the frame; putting it back is the change of its parent.
