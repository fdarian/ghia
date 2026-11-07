---
'@ghia/native': patch
---

`getPatchCounters().scrollPatch` counts the frames after a wheel event over a `<virtual-list>` that could be a translate of the rows by what would change on screen, not by the hitboxes under the pointer: `Hover` is a pointer whose move from one element to another would restyle something (`hover`, a group, `whileHover`, `:has(:hover)`) or reach a listener (`pointerenter`, `pointerleave`, `pointerover`, `pointerout` and the mouse ones, also on `window`), and `HitboxChain` (in `held` only) counts the hitboxes that change under it. A root nested in a row that was built is no `NotRelocatable` run any more, and `held` names the edge a recording leaves bare (`Region.top`, `Region.bottom`, `Region.side`) and why a row cannot be moved (`NotRelocatable.noRun`, `.noRecording`, `.unmovable`). In the mailbox proxy 328 of 720 frames are eligible and none mispredicted (none before). Every frame is still drawn whole.
