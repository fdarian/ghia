---
'@ghia/native': patch
---

A patched tick whose changed operations keep their kind and bounds (a colour loop, a caret blink, a stroke that moves inside its box) writes their primitives over their slots in the scene's typed vectors, instead of replaying the whole frame's operations and sorting every vector again: several million instructions on a 2700 operation frame, whatever the number of operations that changed. The first patch after a frame built whole still makes the scene again, and so does a patch that moves a primitive, clips one away or changes an operation that is not a plain primitive. `getPatchCounters()` has `sceneRebuilds` and `inPlacePrimitives` for it.
