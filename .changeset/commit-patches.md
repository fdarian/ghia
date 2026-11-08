---
'@ghia/native': patch
---

A commit that only changes how elements paint is drawn as a patch frame, as a hover that only paints is: the roots that hold the restyled elements are built again and gpui writes the primitives they paint over the frame shown, and the layout stays current, so a read of `scrollTop` or `clientHeight` after the commit runs no layout pass. A restyle qualifies when it keeps the operations of the root (the comparison a hover makes: colours that keep their visibility, an opacity on the same side of 1, a background quad that is kept in both styles), and a state style (`hover`, `hasHover`, `focusVisible`, ...) whose refinement differs only in paint is a paint change now (it made the style a layout change, so the mailbox row of ghia-bench took a layout pass for a selection). Anything else, or an element no root of the last frame built whole holds (`getPatchCounters().unpatchable.Commit`), is drawn whole as before.
