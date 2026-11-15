---
"@ghia/native": patch
---

A layout read after a swap of class-styled content no longer builds the frame whole. A subtree taken out of the document (a Solid `<Show>` swap, `removeChild`) loses its stylesheet matches, as in a browser, and that restyle of an element no frame draws was counted as a `Structure` change that no anchor holds, so a read of `scrollTop`, `clientHeight` or `scrollHeight` in the same handler declined the patch (`Read:Structure`) and the frame was built whole. Inline-styled content was not affected. An element that is not under the window's root now records no change of the frame; putting it back is the change of its parent. The same holds for an element changed and then taken out in the same batch (`setStyle` or a class toggle, then `detachChild`, or a subtree kept out for a later frame): the patch planner leaves it out, as it does a destroyed one, and the removal is the parent's change.
