---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

Two Web Animations gaps `@dnd-kit/dom` hit. Removing or unmounting an element no longer cancels its `element.animate()` animations: the run goes on against the removed element, `finished` resolves on time instead of rejecting with an `AbortError`, and an element inserted again is still animating where the clock took it (its CSS animations and transitions still end with it, and `getAnimations()` of a removed Solid element lists the animations it kept). `getKeyframes()` of a transition that was retargeted while it ran (a 3D `translate`, as dnd-kit writes it) no longer throws `NotSupportedError`; a `translate` is serialized as CSS does, and `getKeyframes()` of an `element.animate()` animation reports `offset: null` for a keyframe that was given none.
