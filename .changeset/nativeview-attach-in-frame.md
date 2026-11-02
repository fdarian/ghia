---
'@ghia/native': patch
---

`<nativeview>`: `onAttach` now runs inside the frame that makes the surface (in its prepaint), with a content view that already has the size of the element's padding box, instead of one event-queue turn after the frame. The view a library adds there is in its container when the frame places it, and the frame presents the view and the GPUI content around it with one Core Animation transaction, so a new glass view no longer shows for a frame before or after the content above it. Like `onDetach`, `onAttach` can no longer call gpuix (a renderer call from it fails with the nested-call error) and the state it writes is a later batch: children that wait for `onAttach` show a frame after the view, so a library should render them from the first frame. Where native cannot call JS from inside a frame, `attach` is still queued.
