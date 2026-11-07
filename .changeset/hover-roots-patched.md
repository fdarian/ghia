---
'@ghia/native': patch
---

A hover that only changes how an element paints is drawn by patching the frame shown: the roots that hold it (a row, a card, a small control) are built again and gpui writes the primitives they paint over the frame, where the whole page was built. The frame built whole leaves the roots that hold such a hover ready (`retained(..).patchable()` for a root of at most 64 elements that lifts nothing, has no group and no intrinsic size); the preview of a tick takes the hover from the elements the dispatcher left, and a hover on an element no root holds is a frame built whole (`unpatchable.Hover`). A hover that adds or takes away a primitive (a background where there was none), a group, and a hover a listener hears are frames built whole, as before.
